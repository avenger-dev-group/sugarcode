import type {
  ConversationActivity,
  ConversationMessage,
  ConversationContextCompactionActivity,
  ConversationMcpActivity,
  ConversationOrchestrationActivity,
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
    const contextCompactions: ConversationContextCompactionActivity[] = [];
    const activities: ConversationActivity[] = [];
    const workspaceReads: ConversationWorkspaceReadActivity[] = [];
    const workspaceLists: ConversationWorkspaceListActivity[] = [];
    const workspaceSearches: ConversationWorkspaceSearchActivity[] = [];
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
    let orchestration:
      | {
          id: string;
          tasks: Array<{
            id: string;
            taskId: string;
            clientTaskKey: string;
            childThreadId: string;
            title: string;
            role: 'explorer' | 'worker' | 'auditor';
            access: 'readOnly' | 'workspaceWrite';
            dependsOn: readonly string[];
            taskMarkdown: string;
            status:
              | 'queued'
              | 'running'
              | 'waitingApproval'
              | 'completed'
              | 'failed'
              | 'interrupted'
              | 'cancelled';
            amendments: Array<{ id: string; markdown: string }>;
            result?: {
              id: string;
              summaryMarkdown: string;
              durationMs: number;
            };
          }>;
        }
      | undefined;
    for (const item of turn.items) {
      if (itemIds.has(item.id)) {
        throw new Error('thread/resume returned a duplicate Item ID.');
      }
      itemIds.add(item.id);
      if (item.type === 'agentCommentary') {
        activities.push({
          type: 'commentary',
          activity: {
            id: item.id,
            text: item.text,
            status: 'completed',
          },
        });
      } else if (item.type === 'agentTask') {
        if (orchestration && orchestration.id !== item.orchestrationId) {
          throw new Error('thread/resume returned multiple orchestrations.');
        }
        orchestration ??= { id: item.orchestrationId, tasks: [] };
        orchestration.tasks.push({
          id: item.id,
          taskId: item.taskId,
          clientTaskKey: item.clientTaskKey,
          childThreadId: item.childThreadId,
          title: item.title,
          role: item.role,
          access: item.access,
          dependsOn: [...item.dependsOn],
          taskMarkdown: item.taskMarkdown,
          status: item.dependsOn.length === 0 ? 'running' : 'queued',
          amendments: [],
        });
        continue;
      }
      if (item.type === 'agentTaskAmendment') {
        const task = orchestration?.tasks.find(
          (candidate) =>
            candidate.taskId === item.taskId &&
            orchestration?.id === item.orchestrationId,
        );
        if (!task) {
          throw new Error('thread/resume returned an orphan task amendment.');
        }
        task.amendments.push({
          id: item.id,
          markdown: item.amendmentMarkdown,
        });
        continue;
      }
      if (item.type === 'agentTaskResult') {
        const task = orchestration?.tasks.find(
          (candidate) =>
            candidate.taskId === item.taskId &&
            orchestration?.id === item.orchestrationId,
        );
        if (!task || task.result) {
          throw new Error('thread/resume returned an orphan task result.');
        }
        task.status = item.status;
        task.result = {
          id: item.id,
          summaryMarkdown: item.summaryMarkdown,
          durationMs: item.durationMs,
        };
        continue;
      }
      if (item.type === 'contextCompaction') {
        const outcome =
          item.outcome ??
          (turn.status === 'interrupted'
            ? ({ type: 'interrupted' } as const)
            : undefined);
        if (!outcome) {
          throw new Error(
            'thread/resume returned terminal context compaction without an outcome.',
          );
        }
        contextCompactions.push({
          id: item.id,
          strategy: item.strategy,
          ordinal: item.ordinal,
          preContextBytes: item.preContextBytes,
          sourceMessages: item.sourceMessages,
          sourceBytes: item.sourceBytes,
          sourceSha256: item.sourceSha256,
          status: 'completed',
          outcome,
        });
        activities.push({
          type: 'contextCompaction',
          activity: contextCompactions[contextCompactions.length - 1],
        });
      } else if (item.type === 'userMessage' || item.type === 'agentMessage') {
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
          workspaceReads.some((activity) => activity.callId === item.callId)
        ) {
          throw new Error(
            'thread/resume returned a duplicate workspace/read call.',
          );
        }
        workspaceRead = {
          id: item.id,
          callId: item.callId,
          path: item.path,
          callStatus: 'completed',
        };
        workspaceReads.push(workspaceRead);
        activities.push({ type: 'workspaceRead', activity: workspaceRead });
        continue;
      }
      if (item.type === 'workspaceReadResult') {
        const readIndex = workspaceReads.findIndex(
          (activity) => activity.callId === item.callId,
        );
        const matchingRead = workspaceReads[readIndex];
        if (!matchingRead || matchingRead.result) {
          throw new Error(
            'thread/resume returned an unmatched workspace/read result.',
          );
        }
        const completedRead: ConversationWorkspaceReadActivity = {
          ...matchingRead,
          result: {
            id: item.id,
            status: 'completed',
            outcome: { ...item.outcome },
          },
        };
        workspaceReads[readIndex] = completedRead;
        if (workspaceRead?.callId === item.callId) {
          workspaceRead = completedRead;
        }
        const index = activities.findIndex(
          (entry) =>
            entry.type === 'workspaceRead' &&
            entry.activity.callId === item.callId,
        );
        activities[index] = {
          type: 'workspaceRead',
          activity: completedRead,
        };
        continue;
      }
      if (item.type === 'workspaceListCall') {
        if (
          workspaceLists.some((activity) => activity.callId === item.callId)
        ) {
          throw new Error(
            'thread/resume returned a duplicate workspace/list call.',
          );
        }
        workspaceList = {
          id: item.id,
          callId: item.callId,
          path: item.path,
          callStatus: 'completed',
        };
        workspaceLists.push(workspaceList);
        activities.push({ type: 'workspaceList', activity: workspaceList });
        continue;
      }
      if (item.type === 'workspaceListResult') {
        const listIndex = workspaceLists.findIndex(
          (activity) => activity.callId === item.callId,
        );
        const matchingList = workspaceLists[listIndex];
        if (!matchingList || matchingList.result) {
          throw new Error(
            'thread/resume returned an unmatched workspace/list result.',
          );
        }
        const completedList: ConversationWorkspaceListActivity = {
          ...matchingList,
          result: {
            id: item.id,
            status: 'completed',
            outcome: { ...item.outcome },
          },
        };
        workspaceLists[listIndex] = completedList;
        if (workspaceList?.callId === item.callId) {
          workspaceList = completedList;
        }
        const index = activities.findIndex(
          (entry) =>
            entry.type === 'workspaceList' &&
            entry.activity.callId === item.callId,
        );
        activities[index] = {
          type: 'workspaceList',
          activity: completedList,
        };
        continue;
      }
      if (item.type === 'workspaceSearchCall') {
        if (
          workspaceSearches.some(
            (activity) => activity.callId === item.callId,
          )
        ) {
          throw new Error(
            'thread/resume returned a duplicate workspace/search call.',
          );
        }
        workspaceSearch = {
          id: item.id,
          callId: item.callId,
          path: item.path,
          query: item.query,
          callStatus: 'completed',
        };
        workspaceSearches.push(workspaceSearch);
        activities.push({ type: 'workspaceSearch', activity: workspaceSearch });
        continue;
      }
      if (item.type === 'workspaceSearchResult') {
        const searchIndex = workspaceSearches.findIndex(
          (activity) => activity.callId === item.callId,
        );
        const matchingSearch = workspaceSearches[searchIndex];
        if (!matchingSearch || matchingSearch.result) {
          throw new Error(
            'thread/resume returned an unmatched workspace/search result.',
          );
        }
        const completedSearch: ConversationWorkspaceSearchActivity = {
          ...matchingSearch,
          result: {
            id: item.id,
            status: 'completed',
            outcome: { ...item.outcome },
          },
        };
        workspaceSearches[searchIndex] = completedSearch;
        if (workspaceSearch?.callId === item.callId) {
          workspaceSearch = completedSearch;
        }
        const index = activities.findIndex(
          (entry) =>
            entry.type === 'workspaceSearch' &&
            entry.activity.callId === item.callId,
        );
        activities[index] = {
          type: 'workspaceSearch',
          activity: completedSearch,
        };
        continue;
      }
      if (item.type === 'workspacePatchCall') {
        if (fileChange && !fileChange.result) {
          throw new Error(
            'thread/resume returned overlapping workspace/apply-patch activity.',
          );
        }
        fileChange = {
          id: item.id,
          callId: item.callId,
          path: item.path,
          callStatus: 'completed',
        };
        activities.push({ type: 'fileChange', activity: fileChange });
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
        const changeIndex = activities.findIndex(
          (entry) =>
            entry.type === 'fileChange' &&
            entry.activity.callId === item.callId,
        );
        activities[changeIndex] = { type: 'fileChange', activity: fileChange };
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
              fileChange.change.beforeSha256 !== item.outcome.beforeSha256 ||
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
        const resultIndex = activities.findIndex(
          (entry) =>
            entry.type === 'fileChange' &&
            entry.activity.callId === item.callId,
        );
        activities[resultIndex] = { type: 'fileChange', activity: fileChange };
        continue;
      }
      if (item.type === 'mcpCall') {
        if (
          mcpCall ||
          mcpActivities.length >= 4 ||
          mcpActivities.some((activity) => !activity.result)
        ) {
          throw new Error('thread/resume returned a non-sequential MCP call.');
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
        activities.push({
          type: 'mcp',
          activity: mcpActivities[mcpActivities.length - 1],
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
        const activityIndex = activities.findIndex(
          (entry) =>
            entry.type === 'mcp' &&
            entry.activity.approvalId === item.approvalId,
        );
        activities[activityIndex] = {
          type: 'mcp',
          activity: mcpActivities[index],
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
        const activityIndex = activities.findIndex(
          (entry) =>
            entry.type === 'mcp' &&
            entry.activity.approvalId === item.approvalId,
        );
        activities[activityIndex] = {
          type: 'mcp',
          activity: mcpActivities[index],
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
        const activityIndex = activities.findIndex(
          (entry) =>
            entry.type === 'mcp' && entry.activity.callId === item.callId,
        );
        activities[activityIndex] = {
          type: 'mcp',
          activity: mcpActivities[index],
        };
        continue;
      }
      if (item.type === 'commandCall') {
        if (
          commandCall ||
          (commandApproval &&
            !commandApproval.executionResult &&
            commandApproval.decision?.value === 'approved')
        ) {
          throw new Error(
            'thread/resume returned overlapping command approval activity.',
          );
        }
        commandApproval = undefined;
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
          JSON.stringify(commandCall.arguments) !==
            JSON.stringify(item.arguments)
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
        activities.push({
          type: 'commandApproval',
          activity: commandApproval,
        });
        commandCall = undefined;
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
        const index = activities.findIndex(
          (entry) =>
            entry.type === 'commandApproval' &&
            entry.activity.approvalId === item.approvalId,
        );
        activities[index] = {
          type: 'commandApproval',
          activity: commandApproval,
        };
        continue;
      }
      if (item.type === 'commandExecutionAttempt') {
        if (!commandApproval && commandCall?.callId === item.callId) {
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
        const index = activities.findIndex(
          (entry) =>
            entry.type === 'commandApproval' &&
            entry.activity.approvalId === item.approvalId,
        );
        activities[index] = {
          type: 'commandApproval',
          activity: commandApproval,
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
        const index = activities.findIndex(
          (entry) =>
            entry.type === 'commandApproval' &&
            entry.activity.callId === item.callId,
        );
        activities[index] = {
          type: 'commandApproval',
          activity: commandApproval,
        };
      }
    }
    if (orchestration) {
      if (turn.status === 'interrupted') {
        for (const task of orchestration.tasks) {
          if (!task.result) {
            task.status = 'interrupted';
          }
        }
      }
      activities.push({
        type: 'orchestration',
        activity: orchestration as ConversationOrchestrationActivity,
      });
    }

    if (
      turn.status !== 'interrupted' &&
      workspaceReads.some((activity) => !activity.result)
    ) {
      throw new Error(
        'thread/resume returned terminal workspace/read activity without a result.',
      );
    }
    if (
      turn.status !== 'interrupted' &&
      workspaceLists.some((activity) => !activity.result)
    ) {
      throw new Error(
        'thread/resume returned terminal workspace/list activity without a result.',
      );
    }
    if (
      turn.status !== 'interrupted' &&
      workspaceSearches.some((activity) => !activity.result)
    ) {
      throw new Error(
        'thread/resume returned terminal workspace/search activity without a result.',
      );
    }
    if (fileChange && turn.status !== 'interrupted' && !fileChange.result) {
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
      ...(turn.model ? { model: { ...turn.model } } : {}),
      messages,
      ...(activities.length > 0 ? { activities } : {}),
      ...(contextCompactions.length > 0 ? { contextCompactions } : {}),
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
