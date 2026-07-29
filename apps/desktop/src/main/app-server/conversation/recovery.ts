import type {
  ConversationMessage,
  ConversationMcpActivity,
  ConversationCommandApprovalActivity,
  ConversationFileChangeActivity,
  ConversationTurn,
  ConversationWorkspaceListActivity,
  ConversationWorkspaceReadActivity,
  ConversationWorkspaceSearchActivity,
} from '@/shared/conversation';

import type { ResumeSnapshot } from './protocol';

export type RecoveredConversation = Readonly<{
  threadId: string;
  turns: readonly ConversationTurn[];
}>;

export const recoverConversation = (
  expectedThreadId: string,
  snapshot: ResumeSnapshot,
): RecoveredConversation => {
  if (snapshot.threadId !== expectedThreadId) {
    throw new Error('thread/resume returned another Thread.');
  }

  const turnIds = new Set<string>();
  const itemIds = new Set<string>();
  const turns = snapshot.turns.map((turn): ConversationTurn => {
    if (turn.status === 'inProgress') {
      throw new Error('thread/resume returned an in-progress Turn.');
    }
    if (turnIds.has(turn.id)) {
      throw new Error('thread/resume returned a duplicate Turn ID.');
    }
    turnIds.add(turn.id);

    const messages: ConversationMessage[] = [];
    let workspaceRead: ConversationWorkspaceReadActivity | undefined;
    let workspaceList: ConversationWorkspaceListActivity | undefined;
    let workspaceSearch: ConversationWorkspaceSearchActivity | undefined;
    let fileChange: ConversationFileChangeActivity | undefined;
    let commandCall:
      | Readonly<{
          id: string;
          callId: string;
          command: string;
          arguments: readonly string[];
        }>
      | undefined;
    let commandApproval: ConversationCommandApprovalActivity | undefined;
    let mcpCall:
      | Readonly<{
          id: string;
          callId: string;
          name: string;
          argumentsBytes: number;
          argumentsSha256: string;
          inventorySha256: string;
          argumentSignature: string;
        }>
      | undefined;
    const mcpActivities: ConversationMcpActivity[] = [];
    for (const item of turn.items) {
      if (itemIds.has(item.id)) {
        throw new Error('thread/resume returned a duplicate Item ID.');
      }
      itemIds.add(item.id);
      if (item.type === 'userMessage' || item.type === 'agentMessage') {
        messages.push({
          id: item.id,
          role: item.type === 'userMessage' ? 'user' : 'agent',
          text: item.text,
          status: 'completed',
        });
        continue;
      }
      if (item.type === 'workspaceReadCall') {
        if (
          workspaceRead ||
          workspaceList ||
          workspaceSearch ||
          fileChange ||
          commandCall ||
          commandApproval ||
          mcpCall ||
          mcpActivities.length > 0
        ) {
          throw new Error(
            'thread/resume returned duplicate workspace/read activity.',
          );
        }
        workspaceRead = {
          id: item.id,
          callId: item.callId,
          path: item.path,
          callStatus: 'completed',
        };
        continue;
      }
      if (item.type === 'workspaceReadResult') {
        if (
          !workspaceRead ||
          workspaceRead.callId !== item.callId ||
          workspaceRead.result
        ) {
          throw new Error(
            'thread/resume returned an unmatched workspace/read result.',
          );
        }
        workspaceRead = {
          ...workspaceRead,
          result: {
            id: item.id,
            status: 'completed',
            outcome: { ...item.outcome },
          },
        };
        continue;
      }
      if (item.type === 'workspaceListCall') {
        if (
          workspaceList ||
          workspaceRead ||
          workspaceSearch ||
          fileChange ||
          commandCall ||
          commandApproval ||
          mcpCall ||
          mcpActivities.length > 0
        ) {
          throw new Error(
            'thread/resume returned duplicate workspace/list activity.',
          );
        }
        workspaceList = {
          id: item.id,
          callId: item.callId,
          path: item.path,
          callStatus: 'completed',
        };
        continue;
      }
      if (item.type === 'workspaceListResult') {
        if (
          !workspaceList ||
          workspaceList.callId !== item.callId ||
          workspaceList.result
        ) {
          throw new Error(
            'thread/resume returned an unmatched workspace/list result.',
          );
        }
        workspaceList = {
          ...workspaceList,
          result: {
            id: item.id,
            status: 'completed',
            outcome: { ...item.outcome },
          },
        };
        continue;
      }
      if (item.type === 'workspaceSearchCall') {
        if (
          workspaceSearch ||
          workspaceRead ||
          workspaceList ||
          fileChange ||
          commandCall ||
          commandApproval ||
          mcpCall ||
          mcpActivities.length > 0
        ) {
          throw new Error(
            'thread/resume returned duplicate workspace/search activity.',
          );
        }
        workspaceSearch = {
          id: item.id,
          callId: item.callId,
          path: item.path,
          query: item.query,
          callStatus: 'completed',
        };
        continue;
      }
      if (item.type === 'workspaceSearchResult') {
        if (
          !workspaceSearch ||
          workspaceSearch.callId !== item.callId ||
          workspaceSearch.result
        ) {
          throw new Error(
            'thread/resume returned an unmatched workspace/search result.',
          );
        }
        workspaceSearch = {
          ...workspaceSearch,
          result: {
            id: item.id,
            status: 'completed',
            outcome: { ...item.outcome },
          },
        };
        continue;
      }
      if (item.type === 'workspacePatchCall') {
        if (
          workspaceRead ||
          workspaceList ||
          workspaceSearch ||
          fileChange ||
          commandCall ||
          commandApproval ||
          mcpCall ||
          mcpActivities.length > 0
        ) {
          throw new Error(
            'thread/resume returned duplicate workspace/apply-patch activity.',
          );
        }
        fileChange = {
          id: item.id,
          callId: item.callId,
          path: item.path,
          callStatus: 'completed',
        };
        continue;
      }
      if (item.type === 'workspacePatchChange') {
        if (
          !fileChange ||
          fileChange.callId !== item.callId ||
          fileChange.path !== item.path ||
          fileChange.change ||
          fileChange.result
        ) {
          throw new Error(
            'thread/resume returned an unmatched FileChange proposal.',
          );
        }
        fileChange = {
          ...fileChange,
          change: {
            id: item.id,
            status: 'completed',
            path: item.path,
            kind: item.kind,
            diff: item.diff,
            beforeSha256: item.beforeSha256,
            afterSha256: item.afterSha256,
            beforeBytes: item.beforeBytes,
            afterBytes: item.afterBytes,
            newlineStyle: item.newlineStyle,
            finalNewline: item.finalNewline,
          },
        };
        continue;
      }
      if (item.type === 'workspacePatchResult') {
        if (
          !fileChange ||
          fileChange.callId !== item.callId ||
          fileChange.result ||
          (item.outcome.type === 'success' &&
            (!fileChange.change ||
              fileChange.change.path !== item.outcome.path ||
              fileChange.change.beforeSha256 !==
                item.outcome.beforeSha256 ||
              fileChange.change.afterSha256 !== item.outcome.afterSha256 ||
              fileChange.change.beforeBytes !== item.outcome.beforeBytes ||
              fileChange.change.afterBytes !== item.outcome.afterBytes))
        ) {
          throw new Error(
            'thread/resume returned an unmatched workspace/apply-patch result.',
          );
        }
        fileChange = {
          ...fileChange,
          result: {
            id: item.id,
            status: 'completed',
            outcome: { ...item.outcome },
          },
        };
        continue;
      }
      if (item.type === 'mcpCall') {
        if (
          workspaceRead ||
          workspaceList ||
          workspaceSearch ||
          fileChange ||
          commandCall ||
          commandApproval ||
          mcpCall ||
          mcpActivities.length >= 4 ||
          mcpActivities.some((activity) => !activity.result)
        ) {
          throw new Error(
            'thread/resume returned a non-sequential MCP call.',
          );
        }
        mcpCall = {
          id: item.id,
          callId: item.callId,
          name: item.name,
          argumentsBytes: item.argumentsBytes,
          argumentsSha256: item.argumentsSha256,
          inventorySha256: item.inventorySha256,
          argumentSignature: item.argumentSignature,
        };
        continue;
      }
      if (item.type === 'mcpApprovalRequest') {
        const server = /^mcp__([a-z][a-z0-9]*(?:-[a-z0-9]+)*)__.+$/u.exec(
          item.name,
        )?.[1];
        if (
          !mcpCall ||
          !server ||
          mcpCall.callId !== item.callId ||
          mcpCall.name !== item.name ||
          mcpCall.argumentsBytes !== item.argumentsBytes ||
          mcpCall.argumentsSha256 !== item.argumentsSha256 ||
          mcpCall.inventorySha256 !== item.inventorySha256 ||
          mcpCall.argumentSignature !== item.argumentSignature
        ) {
          throw new Error(
            'thread/resume returned an unmatched MCP approval request.',
          );
        }
        mcpActivities.push({
          callItemId: mcpCall.id,
          id: item.id,
          callId: item.callId,
          approvalId: item.approvalId,
          serverId: server,
          name: item.name,
          argumentsBytes: item.argumentsBytes,
          argumentsSha256: item.argumentsSha256,
          inventorySha256: item.inventorySha256,
          callStatus: 'completed',
          requestStatus: 'completed',
        });
        mcpCall = undefined;
        continue;
      }
      if (item.type === 'mcpApprovalDecision') {
        const index = mcpActivities.findIndex(
          (activity) => activity.approvalId === item.approvalId,
        );
        const activity = mcpActivities[index];
        if (!activity || activity.decision) {
          throw new Error(
            'thread/resume returned an unmatched MCP approval decision.',
          );
        }
        mcpActivities[index] = {
          ...activity,
          decision: {
            id: item.id,
            status: 'completed',
            value: item.decision,
          },
        };
        continue;
      }
      if (item.type === 'mcpExecutionAttempt') {
        const index = mcpActivities.findIndex(
          (activity) => activity.approvalId === item.approvalId,
        );
        const activity = mcpActivities[index];
        if (
          !activity ||
          activity.callId !== item.callId ||
          activity.inventorySha256 !== item.inventorySha256 ||
          activity.decision?.value !== 'approved' ||
          activity.executionAttempt
        ) {
          throw new Error(
            'thread/resume returned an unmatched MCP execution attempt.',
          );
        }
        mcpActivities[index] = {
          ...activity,
          executionAttempt: { id: item.id, status: 'completed' },
        };
        continue;
      }
      if (item.type === 'mcpResult') {
        const index = mcpActivities.findIndex(
          (activity) => activity.callId === item.callId,
        );
        const activity = mcpActivities[index];
        const approved = activity?.decision?.value === 'approved';
        if (
          !activity ||
          activity.name !== item.name ||
          !activity.decision ||
          activity.result ||
          (approved
            ? !activity.executionAttempt
            : Boolean(activity.executionAttempt))
        ) {
          throw new Error('thread/resume returned an unmatched MCP result.');
        }
        mcpActivities[index] = {
          ...activity,
          result: {
            id: item.id,
            status: 'completed',
            receipt: { ...item.receipt },
          },
        };
        continue;
      }
      if (item.type === 'commandCall') {
        if (
          workspaceRead ||
          workspaceList ||
          workspaceSearch ||
          fileChange ||
          commandCall ||
          commandApproval ||
          mcpCall ||
          mcpActivities.length > 0
        ) {
          throw new Error(
            'thread/resume returned duplicate command approval activity.',
          );
        }
        commandCall = {
          id: item.id,
          callId: item.callId,
          command: item.command,
          arguments: [...item.arguments],
        };
        continue;
      }
      if (item.type === 'commandApprovalRequest') {
        if (
          !commandCall ||
          commandApproval ||
          commandCall.callId !== item.callId ||
          commandCall.command !== item.command ||
          JSON.stringify(commandCall.arguments) !== JSON.stringify(item.arguments)
        ) {
          throw new Error(
            'thread/resume returned an unmatched command approval request.',
          );
        }
        commandApproval = {
          callItemId: commandCall.id,
          id: item.id,
          callId: item.callId,
          approvalId: item.approvalId,
          command: item.command,
          argumentCount: item.arguments.length,
          requestStatus: 'completed',
        };
        continue;
      }
      if (item.type === 'commandApprovalDecision') {
        if (!commandApproval) {
          continue;
        }
        if (
          commandApproval.approvalId !== item.approvalId ||
          commandApproval.decision
        ) {
          throw new Error(
            'thread/resume returned an unmatched command approval decision.',
          );
        }
        commandApproval = {
          ...commandApproval,
          decision: {
            id: item.id,
            status: 'completed',
            value: item.decision,
          },
        };
        continue;
      }
      if (item.type === 'commandExecutionAttempt') {
        if (
          !commandApproval &&
          commandCall?.callId === item.callId
        ) {
          continue;
        }
        if (
          !commandApproval ||
          commandApproval.callId !== item.callId ||
          commandApproval.approvalId !== item.approvalId ||
          commandApproval.decision?.status !== 'completed' ||
          commandApproval.decision.value !== 'approved' ||
          commandApproval.executionAttempt
        ) {
          throw new Error(
            'thread/resume returned an unmatched command execution attempt.',
          );
        }
        commandApproval = {
          ...commandApproval,
          executionAttempt: {
            id: item.id,
            status: 'completed',
          },
        };
        continue;
      }
      if (item.type === 'commandExecutionResult') {
        if (!commandApproval && commandCall?.callId === item.callId) {
          continue;
        }
        if (
          commandApproval?.callId === item.callId &&
          commandApproval.decision?.status === 'completed' &&
          commandApproval.decision.value !== 'approved' &&
          !commandApproval.executionAttempt
        ) {
          continue;
        }
        if (
          !commandApproval ||
          commandApproval.callId !== item.callId ||
          commandApproval.decision?.status !== 'completed' ||
          commandApproval.decision.value !== 'approved' ||
          commandApproval.executionAttempt?.status !== 'completed' ||
          commandApproval.executionResult
        ) {
          throw new Error(
            'thread/resume returned an unmatched command execution result.',
          );
        }
        commandApproval = {
          ...commandApproval,
          executionResult: {
            id: item.id,
            status: 'completed',
            outcome: { ...item.outcome },
          },
        };
      }
    }

    if (
      workspaceRead &&
      turn.status !== 'interrupted' &&
      !workspaceRead.result
    ) {
      throw new Error(
        'thread/resume returned terminal workspace/read activity without a result.',
      );
    }
    if (
      workspaceList &&
      turn.status !== 'interrupted' &&
      !workspaceList.result
    ) {
      throw new Error(
        'thread/resume returned terminal workspace/list activity without a result.',
      );
    }
    if (
      workspaceSearch &&
      turn.status !== 'interrupted' &&
      !workspaceSearch.result
    ) {
      throw new Error(
        'thread/resume returned terminal workspace/search activity without a result.',
      );
    }
    if (
      fileChange &&
      turn.status !== 'interrupted' &&
      !fileChange.result
    ) {
      throw new Error(
        'thread/resume returned terminal workspace/apply-patch activity without a result.',
      );
    }
    if (
      commandApproval &&
      turn.status !== 'interrupted' &&
      !commandApproval.decision
    ) {
      throw new Error(
        'thread/resume returned terminal command approval activity without a decision.',
      );
    }
    if (
      commandApproval?.executionAttempt &&
      turn.status !== 'interrupted' &&
      !commandApproval.executionResult
    ) {
      throw new Error(
        'thread/resume returned terminal command execution attempt without a result.',
      );
    }
    if (
      mcpCall ||
      mcpActivities.some(
        (activity) =>
          !activity.decision ||
          (turn.status !== 'interrupted' && !activity.result),
      )
    ) {
      throw new Error(
        'thread/resume returned terminal MCP activity without durable closure.',
      );
    }

    return {
      id: turn.id,
      status: turn.status,
      messages,
      ...(workspaceRead ? { workspaceRead } : {}),
      ...(workspaceList ? { workspaceList } : {}),
      ...(workspaceSearch ? { workspaceSearch } : {}),
      ...(fileChange ? { fileChange } : {}),
      ...(commandApproval ? { commandApproval } : {}),
      ...(mcpActivities.length > 0 ? { mcpActivities } : {}),
      ...(turn.error ? { error: { ...turn.error } } : {}),
    };
  });

  return {
    threadId: snapshot.threadId,
    turns,
  };
};
