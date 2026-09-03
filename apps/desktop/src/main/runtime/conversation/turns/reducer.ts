import type { RuntimeContentPart, RuntimeEvent } from '../../../../runtime/contracts/protocol.ts';
import type {
  ConversationActivity,
  ConversationTokenUsage,
  ConversationTurn,
} from '../../../../shared/conversation.ts';
import {
  isReasoningSummaryCommentaryId,
  isTrustedCommentaryId,
} from '../../../../shared/conversation/trusted-commentary.ts';
import {
  appendUserInputActivity,
  appendToolCallActivity,
  applyToolResultActivity,
  resolveUserInputActivity,
} from '../projection/tool-activities.ts';
import {
  attachmentFromPart,
  commandOutcome,
  orchestrationActivity,
} from '../projection/project-thread.ts';

export const knowledgeReferencesFromParts = (
  content: readonly RuntimeContentPart[],
) =>
  content.flatMap((part) =>
    part.type === 'knowledgeReferences' ? part.references : [],
  );

export const withoutUserInputRequest = (
  turn: ConversationTurn,
): ConversationTurn => {
  const copy: {
    -readonly [Key in keyof ConversationTurn]: ConversationTurn[Key];
  } = { ...turn };
  delete copy.userInputRequest;
  return copy;
};

type TokenUsageSample = ConversationTokenUsage['lastRequest'];

const addTokenUsage = (
  previous: TokenUsageSample | undefined,
  current: TokenUsageSample,
): TokenUsageSample => {
  const add = (
    left: number | undefined,
    right: number | undefined,
  ): number | undefined =>
    left === undefined && right === undefined
      ? undefined
      : (left ?? 0) + (right ?? 0);
  const inputTokens = add(previous?.inputTokens, current.inputTokens);
  const outputTokens = add(previous?.outputTokens, current.outputTokens);
  const reasoningTokens = add(
    previous?.reasoningTokens,
    current.reasoningTokens,
  );
  const cachedInputTokens = add(
    previous?.cachedInputTokens,
    current.cachedInputTokens,
  );
  const totalTokens = add(previous?.totalTokens, current.totalTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
};

// Only per-Turn data transformations belong here. Runtime requests, lifecycle,
// queue dispatch and publication remain the controller's responsibility.
// Undefined means the event is not handled; returning the same Turn preserves
// existing no-op event/revision semantics.
export const reduceConversationTurn = (
  turn: ConversationTurn,
  event: RuntimeEvent,
): ConversationTurn | undefined => {
  let nextTurn = turn;
  switch (event.type) {
    case 'turn.userMessage':
      {
        const existingUser = turn.messages.find(
          (message) => message.role === 'user',
        );
        const text = event.content
          .filter(
            (part): part is Extract<RuntimeContentPart, { type: 'text' }> =>
              part.type === 'text',
          )
          .map((part) => part.text)
          .join('\n');
        const attachments = event.content.flatMap((part) => {
          if (part.type !== 'asset') {
            return [];
          }
          const attachment = attachmentFromPart(part);
          const existingAttachment = existingUser?.attachments?.find(
            (candidate) =>
              candidate.assetId === attachment.assetId &&
              candidate.sha256 === attachment.sha256,
          );
          return [
            {
              ...attachment,
              ...(existingAttachment?.previewUrl
                ? { previewUrl: existingAttachment.previewUrl }
                : {}),
            },
          ];
        });
        const knowledgeReferences = knowledgeReferencesFromParts(
          event.content,
        );
        const userMessage = {
          id: existingUser?.id ?? event.itemId,
          role: 'user' as const,
          text: text || existingUser?.text || '',
          ...(attachments.length > 0
            ? { attachments }
            : existingUser?.attachments?.length
              ? { attachments: existingUser.attachments }
              : {}),
          ...(knowledgeReferences.length > 0 ? { knowledgeReferences } : {}),
          status: 'completed' as const,
        };
        nextTurn = {
          ...turn,
          messages: [
            userMessage,
            ...turn.messages.filter((message) => message.role !== 'user'),
          ],
        };
      }
      break;
    case 'turn.textStarted':
      break;
    case 'turn.textDelta': {
      if (event.phase !== 'final') {
        if (!isTrustedCommentaryId(event.turnId, event.itemId)) {
          break;
        }
        const activities = [...(turn.activities ?? [])];
        const activityType = isReasoningSummaryCommentaryId(
          event.turnId,
          event.itemId,
        )
          ? 'reasoningSummary'
          : 'commentary';
        const activityIndex = activities.findIndex(
          (activity) =>
            activity.type === activityType &&
            activity.activity.id === event.itemId,
        );
        const current = activities[activityIndex];
        if (activityIndex >= 0 && current?.type === activityType) {
          activities[activityIndex] = {
            type: activityType,
            activity: {
              ...current.activity,
              text: current.activity.text + event.delta,
            },
          };
        } else {
          activities.push({
            type: activityType,
            activity: {
              id: event.itemId,
              text: event.delta,
              status: 'inProgress',
            },
          });
        }
        nextTurn = { ...turn, activities };
      } else {
        const messages = [...turn.messages];
        const agentIndex = messages.findIndex(
          (message) =>
            message.role === 'agent' && message.id === event.itemId,
        );
        if (agentIndex >= 0) {
          const current = messages[agentIndex];
          messages[agentIndex] = {
            ...current,
            text: current.text + event.delta,
          };
        } else {
          messages.push({
            id: event.itemId,
            role: 'agent',
            text: event.delta,
            status: 'inProgress',
          });
        }
        nextTurn = { ...turn, messages };
      }
      break;
    }
    case 'turn.textCompleted': {
      if (event.phase === 'commentary') {
        if (!isTrustedCommentaryId(event.turnId, event.itemId)) {
          nextTurn = {
            ...turn,
            messages: turn.messages.filter(
              (message) =>
                message.role !== 'agent' || message.id !== event.itemId,
            ),
            activities: turn.activities?.filter(
              (activity) =>
                (activity.type !== 'commentary' &&
                  activity.type !== 'reasoningSummary') ||
                activity.activity.id !== event.itemId,
            ),
          };
          break;
        }
        const messages = turn.messages.filter(
          (message) =>
            message.role !== 'agent' || message.id !== event.itemId,
        );
        const activities = [...(turn.activities ?? [])];
        const activityType = isReasoningSummaryCommentaryId(
          event.turnId,
          event.itemId,
        )
          ? 'reasoningSummary'
          : 'commentary';
        const activityIndex = activities.findIndex(
          (activity) =>
            activity.type === activityType &&
            activity.activity.id === event.itemId,
        );
        const completed: ConversationActivity = {
          type: activityType,
          activity: {
            id: event.itemId,
            text: event.text,
            status: 'completed' as const,
          },
        };
        if (activityIndex >= 0) {
          activities[activityIndex] = completed;
        } else {
          activities.push(completed);
        }
        nextTurn = { ...turn, messages, activities };
      } else {
        const messages = [
          ...turn.messages.filter((message) => message.role === 'user'),
          {
            id: event.itemId,
            role: 'agent' as const,
            text: event.text,
            status: 'completed' as const,
          },
        ];
        const activities = turn.activities?.filter(
          (activity) =>
            (activity.type !== 'commentary' &&
              activity.type !== 'reasoningSummary') ||
            activity.activity.id !== event.itemId,
        );
        nextTurn = {
          ...turn,
          messages,
          ...(activities ? { activities } : {}),
        };
      }
      break;
    }
    case 'turn.planProposed': {
      nextTurn = {
        ...turn,
        planProposal: {
          id: event.planId,
          content: event.content,
        },
      };
      break;
    }
    case 'turn.toolCall': {
      const activities = [...(turn.activities ?? [])];
      appendToolCallActivity(
        activities,
        event.itemId,
        event.callId,
        event.name,
        event.arguments,
      );
      nextTurn = { ...turn, activities };
      break;
    }
    case 'turn.toolResult': {
      const activities = [...(turn.activities ?? [])];
      applyToolResultActivity(
        activities,
        event.itemId,
        event.callId,
        event.result,
      );
      nextTurn = { ...turn, activities };
      break;
    }
    case 'turn.userInputRequested': {
      const activities = [...(turn.activities ?? [])];
      appendUserInputActivity(
        activities,
        event.inputRequestId,
        event.questions,
      );
      nextTurn = {
        ...turn,
        activities,
        userInputRequest: {
          id: event.inputRequestId,
          questions: event.questions,
        },
      };
      break;
    }
    case 'turn.userInputResolved': {
      const activities = [...(turn.activities ?? [])];
      resolveUserInputActivity(
        activities,
        event.inputRequestId,
        event.submission,
      );
      if (turn.userInputRequest?.id === event.inputRequestId) {
        nextTurn = {
          ...withoutUserInputRequest(turn),
          activities,
        };
      } else {
        nextTurn = { ...turn, activities };
      }
      break;
    }
    case 'turn.usage': {
      const previous = turn.usage;
      const turnTotal = addTokenUsage(previous?.turnTotal, event.usage);
      nextTurn = {
        ...turn,
        usage: {
          lastRequest: event.usage,
          turnTotal,
          requestCount: (previous?.requestCount ?? 0) + 1,
          contextWindowTokens: turn.model?.contextWindowTokens ?? 128_000,
          source: 'provider',
        },
      };
      break;
    }
    case 'turn.contextCompactionStarted': {
      const activities = [...(turn.activities ?? [])];
      activities.push({
        type: 'contextCompaction',
        activity: {
          id: event.compactionId,
          status: 'inProgress',
          trigger: event.trigger,
          strategy: event.strategy,
          ...(event.beforeContextTokens === undefined
            ? {}
            : { beforeContextTokens: event.beforeContextTokens }),
        },
      });
      nextTurn = { ...turn, activities };
      break;
    }
    case 'turn.contextCompactionFinished': {
      const activities = [...(turn.activities ?? [])];
      const activityIndex = activities.findIndex(
        (activity) =>
          activity.type === 'contextCompaction' &&
          activity.activity.id === event.compactionId,
      );
      const next = {
        type: 'contextCompaction' as const,
        activity: {
          id: event.compactionId,
          status: event.outcome,
          trigger: event.trigger,
          strategy: event.strategy,
          ...(event.beforeContextTokens === undefined
            ? {}
            : { beforeContextTokens: event.beforeContextTokens }),
          ...(event.afterContextTokens === undefined
            ? {}
            : { afterContextTokens: event.afterContextTokens }),
          durationMs: event.durationMs,
          ...(event.readableSummary === undefined
            ? {}
            : { readableSummary: event.readableSummary }),
          ...(event.opaqueCheckpoint === undefined
            ? {}
            : { opaqueCheckpoint: event.opaqueCheckpoint }),
          ...(event.message === undefined ? {} : { message: event.message }),
        },
      };
      if (activityIndex >= 0) {
        activities[activityIndex] = next;
      } else {
        activities.push(next);
      }
      nextTurn = { ...turn, activities };
      break;
    }
    case 'agent.task': {
      const activities = [...(turn.activities ?? [])];
      const orchestrationIndex = activities.findIndex(
        (activity) => activity.type === 'orchestration',
      );
      const projected = orchestrationActivity([event.task]);
      if (!projected || projected.type !== 'orchestration') {
        return;
      }
      const projectedTask = projected.activity.tasks[0];
      if (!projectedTask) {
        return;
      }
      if (orchestrationIndex < 0) {
        activities.push(projected);
      } else {
        const activity = activities[orchestrationIndex];
        if (
          activity?.type !== 'orchestration' ||
          activity.activity.id !== event.task.orchestrationId
        ) {
          return;
        }
        const tasks = [...activity.activity.tasks];
        const taskIndex = tasks.findIndex(
          (task) => task.taskId === event.task.taskId,
        );
        if (taskIndex >= 0) {
          tasks[taskIndex] = projectedTask;
        } else {
          tasks.push(projectedTask);
        }
        activities[orchestrationIndex] = {
          type: 'orchestration',
          activity: { ...activity.activity, tasks },
        };
      }
      nextTurn = { ...turn, activities };
      break;
    }
    case 'approval.requested': {
      const activities = [...(turn.activities ?? [])];
      const nextActivity = {
        type: 'commandApproval',
        activity: {
          callItemId: event.operationId,
          id: `${event.approvalId}:request`,
          callId: event.operationId,
          approvalId: event.approvalId,
          operationKind: event.projectEnvironmentTrust
            ? 'projectEnvironment'
            : event.toolName === 'workspace_apply_patch'
              ? 'workspacePatch'
              : 'shell',
          command: event.argumentsSummary,
          argumentCount: 0,
          fullAccess: event.fullAccess,
          requestStatus: 'inProgress',
        },
      } as const;
      const existingIndex = activities.findIndex(
        (activity) =>
          activity.type === 'commandApproval' &&
          activity.activity.approvalId === event.approvalId,
      );
      if (existingIndex >= 0) {
        activities[existingIndex] = nextActivity;
      } else {
        activities.push(nextActivity);
      }
      nextTurn = { ...turn, activities };
      break;
    }
    case 'approval.resolved': {
      const activities = turn.activities?.map((activity) =>
        activity.type === 'commandApproval' &&
        activity.activity.approvalId === event.approvalId
          ? {
              type: 'commandApproval' as const,
              activity: {
                ...activity.activity,
                requestStatus: 'completed' as const,
                decision: {
                  id: `${event.approvalId}:decision`,
                  status: 'completed' as const,
                  value: event.decision,
                  ...(event.source ? { source: event.source } : {}),
                },
              },
            }
          : activity,
      );
      nextTurn = { ...turn, ...(activities ? { activities } : {}) };
      break;
    }
    case 'operation.started': {
      const activities = turn.activities?.map((activity) =>
        activity.type === 'commandApproval' &&
        activity.activity.callId === event.operationId
          ? {
              type: 'commandApproval' as const,
              activity: {
                ...activity.activity,
                executionAttempt: {
                  id: `${event.operationId}:attempt`,
                  status: 'inProgress' as const,
                },
              },
            }
          : activity,
      );
      nextTurn = { ...turn, ...(activities ? { activities } : {}) };
      break;
    }
    case 'operation.output': {
      const activities = turn.activities?.map((activity) => {
        if (
          activity.type !== 'commandApproval' ||
          activity.activity.callId !== event.operationId
        ) {
          return activity;
        }
        const liveOutput = activity.activity.liveOutput ?? {
          stdout: '',
          stderr: '',
        };
        return {
          type: 'commandApproval' as const,
          activity: {
            ...activity.activity,
            liveOutput: {
              ...liveOutput,
              [event.stream]:
                `${liveOutput[event.stream]}${event.delta}`.slice(-64 * 1024),
            },
          },
        };
      });
      nextTurn = { ...turn, ...(activities ? { activities } : {}) };
      break;
    }
    case 'operation.completed': {
      const activities = turn.activities?.map((activity) =>
        activity.type === 'commandApproval' &&
        activity.activity.callId === event.operationId
          ? {
              type: 'commandApproval' as const,
              activity: {
                ...activity.activity,
                executionAttempt: {
                  id: `${event.operationId}:attempt`,
                  status: 'completed' as const,
                },
                executionResult: {
                  id: `${event.operationId}:result`,
                  status: 'completed' as const,
                  outcome: commandOutcome(event.result),
                },
              },
            }
          : activity,
      );
      nextTurn = { ...turn, ...(activities ? { activities } : {}) };
      break;
    }
    default:
      return undefined;
  }
  return nextTurn;
};
