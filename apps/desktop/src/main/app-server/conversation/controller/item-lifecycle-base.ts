import type {
  ConversationMessage,
  ConversationStateSnapshot,
} from '@/shared/conversation';

import type {
  MutableAgentTask,
  MutableCommandApprovalActivity,
  MutableConversationActivity,
  MutableFileChangeActivity,
  MutableMcpActivity,
  MutableMessage,
  MutableTurn,
  MutableWorkspaceListActivity,
  MutableWorkspaceReadActivity,
  MutableWorkspaceSearchActivity,
} from './mutable-state';

export abstract class ConversationItemLifecycleBase {
  protected phase: ConversationStateSnapshot['phase'] = 'unavailable';
  protected threadId: string | null = null;
  protected activeTurnId: string | null = null;
  protected turns: MutableTurn[] = [];
  protected readonly attachmentPreviews = new Map<string, string>();
  protected notice: ConversationStateSnapshot['notice'];
  protected actionAbortController: AbortController | null = null;

  protected abstract publish(): void;

  protected requireThread = (threadId: string): void => {
    if (!this.threadId || this.threadId !== threadId) {
      throw new Error('Conversation lifecycle referenced another Thread.');
    }
  };

  protected requireActiveTurn = (turnId: string): MutableTurn => {
    if (!this.activeTurnId || this.activeTurnId !== turnId) {
      throw new Error('Conversation lifecycle referenced another Turn.');
    }
    const turn = this.turns.find((candidate) => candidate.id === turnId);
    if (!turn || turn.status !== 'inProgress') {
      throw new Error('Conversation active Turn is unavailable.');
    }
    return turn;
  };

  protected requireCorrelatedTurn = (
    threadId: string,
    turnId: string,
  ): MutableTurn => {
    this.requireThread(threadId);
    return this.requireActiveTurn(turnId);
  };

  protected requireMessage = (
    turn: MutableTurn,
    itemId: string,
  ): MutableMessage => {
    const message = turn.messages.find((candidate) => candidate.id === itemId);
    if (!message) {
      throw new Error('Conversation lifecycle referenced another Item.');
    }
    return message;
  };

  protected withAttachmentPreviews = (
    attachments: NonNullable<ConversationMessage['attachments']>,
  ): NonNullable<ConversationMessage['attachments']> =>
    attachments.map((attachment) => {
      const previewUrl = this.attachmentPreviews.get(attachment.assetId);
      return previewUrl ? { ...attachment, previewUrl } : attachment;
    });

  protected clearPendingAgentOutputs = (): boolean => {
    let changed = false;
    for (const turn of this.turns) {
      if (turn.pendingAgentOutputs.length > 0) {
        turn.pendingAgentOutputs = [];
        changed = true;
      }
      for (const message of turn.messages) {
        if (message.agentOutput) {
          delete message.agentOutput;
          changed = true;
        }
      }
    }
    return changed;
  };

  protected requireWorkspaceRead = (
    turn: MutableTurn,
    callId: string,
  ): MutableWorkspaceReadActivity => {
    const activity = turn.activities.find(
      (
        entry,
      ): entry is Extract<
        MutableConversationActivity,
        { type: 'workspaceRead' }
      > => entry.type === 'workspaceRead' && entry.activity.callId === callId,
    )?.activity;
    if (!activity) {
      throw new Error('Workspace read lifecycle referenced another call.');
    }
    return activity;
  };

  protected requireWorkspaceList = (
    turn: MutableTurn,
    callId: string,
  ): MutableWorkspaceListActivity => {
    const activity = turn.activities.find(
      (
        entry,
      ): entry is Extract<
        MutableConversationActivity,
        { type: 'workspaceList' }
      > => entry.type === 'workspaceList' && entry.activity.callId === callId,
    )?.activity;
    if (!activity) {
      throw new Error('Workspace list lifecycle referenced another call.');
    }
    return activity;
  };

  protected requireWorkspaceSearch = (
    turn: MutableTurn,
    callId: string,
  ): MutableWorkspaceSearchActivity => {
    const activity = turn.activities.find(
      (
        entry,
      ): entry is Extract<
        MutableConversationActivity,
        { type: 'workspaceSearch' }
      > => entry.type === 'workspaceSearch' && entry.activity.callId === callId,
    )?.activity;
    if (!activity) {
      throw new Error('Workspace search lifecycle referenced another call.');
    }
    return activity;
  };

  protected requireFileChange = (
    turn: MutableTurn,
    callId: string,
  ): MutableFileChangeActivity => {
    if (!turn.fileChange || turn.fileChange.callId !== callId) {
      throw new Error(
        'Workspace write lifecycle referenced another call.',
      );
    }
    return turn.fileChange;
  };

  protected requireCommandApproval = (
    turn: MutableTurn,
    approvalId: string,
  ): MutableCommandApprovalActivity => {
    const activity = turn.activities.find(
      (
        entry,
      ): entry is Extract<
        MutableConversationActivity,
        { type: 'commandApproval' }
      > =>
        entry.type === 'commandApproval' &&
        entry.activity.approvalId === approvalId,
    )?.activity;
    if (!activity) {
      throw new Error('Command approval lifecycle referenced another request.');
    }
    return activity;
  };

  protected findCommandApprovalByCall = (
    turn: MutableTurn,
    callId: string,
  ): MutableCommandApprovalActivity | undefined =>
    turn.activities.find(
      (
        entry,
      ): entry is Extract<
        MutableConversationActivity,
        { type: 'commandApproval' }
      > =>
        entry.type === 'commandApproval' && entry.activity.callId === callId,
    )?.activity;

  protected requireMcpActivityByApproval = (
    turn: MutableTurn,
    approvalId: string,
  ): MutableMcpActivity => {
    const activity = turn.mcpActivities?.find(
      (candidate) => candidate.approvalId === approvalId,
    );
    if (!activity) {
      throw new Error('MCP lifecycle referenced another approval.');
    }
    return activity;
  };

  protected requireMcpActivityByCall = (
    turn: MutableTurn,
    callId: string,
  ): MutableMcpActivity => {
    const activity = turn.mcpActivities?.find(
      (candidate) => candidate.callId === callId,
    );
    if (!activity) {
      throw new Error('MCP lifecycle referenced another call.');
    }
    return activity;
  };

  protected requireAgentTask = (
    turn: MutableTurn,
    orchestrationId: string,
    taskId: string,
  ): MutableAgentTask => {
    if (turn.orchestration?.id !== orchestrationId) {
      throw new Error('Agent task lifecycle referenced another orchestration.');
    }
    const task = turn.orchestration.tasks.find(
      (candidate) => candidate.taskId === taskId,
    );
    if (!task) {
      throw new Error('Agent task lifecycle referenced another task.');
    }
    return task;
  };

  protected activateReadyAgentTasks = (turn: MutableTurn): void => {
    if (!turn.orchestration) {
      return;
    }
    const byKey = new Map(
      turn.orchestration.tasks.map((task) => [task.clientTaskKey, task]),
    );
    for (const task of turn.orchestration.tasks) {
      if (task.status !== 'queued') {
        continue;
      }
      const dependencies = task.dependsOn
        .map((dependency) => byKey.get(dependency))
        .filter((dependency): dependency is MutableAgentTask =>
          Boolean(dependency),
        );
      if (
        task.role === 'auditor'
          ? dependencies.every((dependency) =>
              ['completed', 'failed', 'interrupted', 'cancelled'].includes(
                dependency.status,
              ),
            )
          : dependencies.every(
              (dependency) => dependency.status === 'completed',
            )
      ) {
        task.status = 'running';
      }
    }
  };

  protected hasItemId = (turn: MutableTurn, itemId: string): boolean =>
    Boolean(
      turn.messages.some((message) => message.id === itemId) ||
      turn.activities.some(
        (entry) => entry.type === 'commentary' && entry.activity.id === itemId,
      ) ||
      turn.activities.some(
        (entry) =>
          (entry.type === 'workspaceRead' ||
            entry.type === 'workspaceList' ||
            entry.type === 'workspaceSearch') &&
          (entry.activity.id === itemId ||
            entry.activity.result?.id === itemId),
      ) ||
      turn.activities.some(
        (entry) =>
          entry.type === 'commandApproval' &&
          (entry.activity.callItemId === itemId ||
            entry.activity.id === itemId ||
            entry.activity.decision?.id === itemId ||
            entry.activity.executionAttempt?.id === itemId ||
            entry.activity.executionResult?.id === itemId),
      ) ||
      turn.contextCompactions?.some((activity) => activity.id === itemId) ||
      turn.workspaceRead?.id === itemId ||
      turn.workspaceRead?.result?.id === itemId ||
      turn.workspaceList?.id === itemId ||
      turn.workspaceList?.result?.id === itemId ||
      turn.workspaceSearch?.id === itemId ||
      turn.workspaceSearch?.result?.id === itemId ||
      turn.fileChange?.id === itemId ||
      turn.fileChange?.change?.id === itemId ||
      turn.fileChange?.result?.id === itemId ||
      turn.pendingCommandCalls?.some((call) => call.id === itemId) ||
      turn.commandApproval?.callItemId === itemId ||
      turn.commandApproval?.id === itemId ||
      turn.commandApproval?.decision?.id === itemId ||
      turn.commandApproval?.executionAttempt?.id === itemId ||
      turn.commandApproval?.executionResult?.id === itemId ||
      turn.pendingMcpCall?.id === itemId ||
      turn.orchestration?.tasks.some(
        (task) =>
          task.id === itemId ||
          task.amendments.some((amendment) => amendment.id === itemId) ||
          task.result?.id === itemId,
      ) ||
      turn.mcpActivities?.some(
        (activity) =>
          activity.callItemId === itemId ||
          activity.id === itemId ||
          activity.decision?.id === itemId ||
          activity.executionAttempt?.id === itemId ||
          activity.result?.id === itemId,
      ),
    );

}
