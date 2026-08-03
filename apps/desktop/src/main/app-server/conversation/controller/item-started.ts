import type { ConversationLifecycle } from '../protocol';
import { removePendingAgentOutput } from '../agent-output-lifecycle';
import {
  patchResultMatchesChange,
  toFileChangeProposal,
} from './lifecycle-comparison';
import { ConversationItemLifecycleBase } from './item-lifecycle-base';
import type {
  MutableCommandApprovalActivity,
  MutableContextCompactionActivity,
  MutableFileChangeActivity,
  MutableMcpActivity,
  MutableWorkspaceListActivity,
  MutableWorkspaceReadActivity,
  MutableWorkspaceSearchActivity,
} from './mutable-state';

export abstract class ConversationItemStartedController extends ConversationItemLifecycleBase {
  protected applyItemStarted = (
    lifecycle: Extract<ConversationLifecycle, { type: 'itemStarted' }>,
  ): void => {
    const turn = this.requireCorrelatedTurn(
      lifecycle.params.threadId,
      lifecycle.params.turnId,
    );
    if (this.hasItemId(turn, lifecycle.params.item.id)) {
      throw new Error('Duplicate conversation Item ID.');
    }
    const sourceOutput = lifecycle.params.agentOutput;
    if (
      sourceOutput &&
      lifecycle.params.item.type !== 'agentMessage' &&
      lifecycle.params.item.type !== 'agentCommentary'
    ) {
      throw new Error('Agent output resolved to a non-text Item.');
    }
    if (
      lifecycle.params.item.type === 'userMessage' ||
      lifecycle.params.item.type === 'agentMessage'
    ) {
      turn.messages.push({
        id: lifecycle.params.item.id,
        role:
          lifecycle.params.item.type === 'userMessage' ? 'user' : 'agent',
        text: lifecycle.params.item.text,
        ...(lifecycle.params.item.type === 'userMessage' &&
        lifecycle.params.item.attachments.length > 0
          ? {
              attachments: this.withAttachmentPreviews(
                lifecycle.params.item.attachments,
              ),
            }
          : {}),
        status: 'inProgress',
        ...(sourceOutput ? { agentOutput: { ...sourceOutput } } : {}),
      });
    } else if (lifecycle.params.item.type === 'agentCommentary') {
      if (sourceOutput) {
        removePendingAgentOutput(turn.pendingAgentOutputs, sourceOutput);
      }
      turn.activities.push({
        type: 'commentary',
        activity: {
          id: lifecycle.params.item.id,
          text: lifecycle.params.item.text,
          status: 'inProgress',
        },
      });
    } else if (lifecycle.params.item.type === 'agentTask') {
      const item = lifecycle.params.item;
      if (
        turn.orchestration &&
        turn.orchestration.id !== item.orchestrationId
      ) {
        throw new Error('A Turn cannot contain multiple orchestrations.');
      }
      turn.orchestration ??= {
        id: item.orchestrationId,
        tasks: [],
      };
      if (
        turn.orchestration.tasks.some(
          (task) =>
            task.taskId === item.taskId ||
            task.clientTaskKey === item.clientTaskKey,
        )
      ) {
        throw new Error('Duplicate agent task.');
      }
      turn.orchestration.tasks.push({
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
      if (
        !turn.activities.some((entry) => entry.type === 'orchestration')
      ) {
        turn.activities.push({
          type: 'orchestration',
          activity: turn.orchestration,
        });
      }
    } else if (lifecycle.params.item.type === 'agentTaskAmendment') {
      const task = this.requireAgentTask(
        turn,
        lifecycle.params.item.orchestrationId,
        lifecycle.params.item.taskId,
      );
      task.amendments.push({
        id: lifecycle.params.item.id,
        markdown: lifecycle.params.item.amendmentMarkdown,
      });
    } else if (lifecycle.params.item.type === 'agentTaskResult') {
      const task = this.requireAgentTask(
        turn,
        lifecycle.params.item.orchestrationId,
        lifecycle.params.item.taskId,
      );
      if (task.result) {
        throw new Error('Duplicate agent task result.');
      }
      task.status = lifecycle.params.item.status;
      task.result = {
        id: lifecycle.params.item.id,
        summaryMarkdown: lifecycle.params.item.summaryMarkdown,
        durationMs: lifecycle.params.item.durationMs,
      };
      this.activateReadyAgentTasks(turn);
    } else if (lifecycle.params.item.type === 'contextCompaction') {
      const item = lifecycle.params.item;
      turn.contextCompactions ??= [];
      if (
        item.outcome ||
        turn.contextCompactions.some(
          (activity) => activity.ordinal === item.ordinal,
        )
      ) {
        throw new Error('Invalid started context compaction.');
      }
      const activity: MutableContextCompactionActivity = {
        id: item.id,
        strategy: item.strategy,
        ordinal: item.ordinal,
        preContextBytes: item.preContextBytes,
        sourceMessages: item.sourceMessages,
        sourceBytes: item.sourceBytes,
        sourceSha256: item.sourceSha256,
        status: 'inProgress',
      };
      turn.contextCompactions.push(activity);
      turn.activities.push({ type: 'contextCompaction', activity });
    } else if (lifecycle.params.item.type === 'workspaceReadCall') {
      const callId = lifecycle.params.item.callId;
      if (
        turn.activities.some(
          (entry) =>
            entry.type === 'workspaceRead' &&
            entry.activity.callId === callId,
        )
      ) {
        throw new Error('Duplicate workspace/read call.');
      }
      const activity: MutableWorkspaceReadActivity = {
        id: lifecycle.params.item.id,
        callId: lifecycle.params.item.callId,
        path: lifecycle.params.item.path,
        callStatus: 'inProgress',
      };
      turn.workspaceRead = activity;
      turn.activities.push({ type: 'workspaceRead', activity });
    } else if (lifecycle.params.item.type === 'workspaceReadResult') {
      const workspaceRead = this.requireWorkspaceRead(
        turn,
        lifecycle.params.item.callId,
      );
      if (
        workspaceRead.callStatus !== 'completed' ||
        workspaceRead.result
      ) {
        throw new Error('Workspace read result started out of order.');
      }
      workspaceRead.result = {
        id: lifecycle.params.item.id,
        status: 'inProgress',
        outcome: { ...lifecycle.params.item.outcome },
      };
    } else if (lifecycle.params.item.type === 'workspaceListCall') {
      const callId = lifecycle.params.item.callId;
      if (
        turn.activities.some(
          (entry) =>
            entry.type === 'workspaceList' &&
            entry.activity.callId === callId,
        )
      ) {
        throw new Error('Duplicate workspace/list call.');
      }
      const activity: MutableWorkspaceListActivity = {
        id: lifecycle.params.item.id,
        callId: lifecycle.params.item.callId,
        path: lifecycle.params.item.path,
        callStatus: 'inProgress',
      };
      turn.workspaceList = activity;
      turn.activities.push({ type: 'workspaceList', activity });
    } else if (lifecycle.params.item.type === 'workspaceListResult') {
      const workspaceList = this.requireWorkspaceList(
        turn,
        lifecycle.params.item.callId,
      );
      if (
        workspaceList.callStatus !== 'completed' ||
        workspaceList.result
      ) {
        throw new Error('Workspace list result started out of order.');
      }
      workspaceList.result = {
        id: lifecycle.params.item.id,
        status: 'inProgress',
        outcome: { ...lifecycle.params.item.outcome },
      };
    } else if (lifecycle.params.item.type === 'workspaceSearchCall') {
      const callId = lifecycle.params.item.callId;
      if (
        turn.activities.some(
          (entry) =>
            entry.type === 'workspaceSearch' &&
            entry.activity.callId === callId,
        )
      ) {
        throw new Error('Duplicate workspace/search call.');
      }
      const activity: MutableWorkspaceSearchActivity = {
        id: lifecycle.params.item.id,
        callId: lifecycle.params.item.callId,
        path: lifecycle.params.item.path,
        query: lifecycle.params.item.query,
        callStatus: 'inProgress',
      };
      turn.workspaceSearch = activity;
      turn.activities.push({ type: 'workspaceSearch', activity });
    } else if (lifecycle.params.item.type === 'workspaceSearchResult') {
      const workspaceSearch = this.requireWorkspaceSearch(
        turn,
        lifecycle.params.item.callId,
      );
      if (
        workspaceSearch.callStatus !== 'completed' ||
        workspaceSearch.result
      ) {
        throw new Error('Workspace search result started out of order.');
      }
      workspaceSearch.result = {
        id: lifecycle.params.item.id,
        status: 'inProgress',
        outcome: { ...lifecycle.params.item.outcome },
      };
    } else if (lifecycle.params.item.type === 'workspacePatchCall') {
      if (turn.fileChange && !turn.fileChange.result) {
        throw new Error('Duplicate workspace/apply-diff activity.');
      }
      const activity: MutableFileChangeActivity = {
        id: lifecycle.params.item.id,
        callId: lifecycle.params.item.callId,
        path: lifecycle.params.item.path,
        callStatus: 'inProgress',
      };
      turn.fileChange = activity;
      turn.activities.push({ type: 'fileChange', activity });
    } else if (lifecycle.params.item.type === 'workspacePatchChange') {
      const activity = this.requireFileChange(
        turn,
        lifecycle.params.item.callId,
      );
      if (
        activity.callStatus !== 'completed' ||
        activity.path !== lifecycle.params.item.path ||
        activity.change ||
        activity.result
      ) {
        throw new Error('FileChange proposal started out of order.');
      }
      activity.change = toFileChangeProposal(lifecycle.params.item);
    } else if (lifecycle.params.item.type === 'workspacePatchResult') {
      const activity = this.requireFileChange(
        turn,
        lifecycle.params.item.callId,
      );
      if (
        activity.callStatus !== 'completed' ||
        activity.result ||
        !patchResultMatchesChange(
          lifecycle.params.item.outcome,
          activity.change,
        )
      ) {
        throw new Error(
          'Workspace write result started out of order.',
        );
      }
      activity.result = {
        id: lifecycle.params.item.id,
        status: 'inProgress',
        outcome: { ...lifecycle.params.item.outcome },
      };
    } else if (lifecycle.params.item.type === 'mcpCall') {
      if (
        turn.pendingMcpCall ||
        (turn.mcpActivities?.length ?? 0) >= 4 ||
        turn.mcpActivities?.some((activity) => !activity.result)
      ) {
        throw new Error(
          'MCP call started outside the sequential boundary.',
        );
      }
      turn.pendingMcpCall = {
        id: lifecycle.params.item.id,
        callId: lifecycle.params.item.callId,
        name: lifecycle.params.item.name,
        argumentsBytes: lifecycle.params.item.argumentsBytes,
        argumentsSha256: lifecycle.params.item.argumentsSha256,
        inventorySha256: lifecycle.params.item.inventorySha256,
        argumentSignature: lifecycle.params.item.argumentSignature,
        status: 'inProgress',
      };
    } else if (lifecycle.params.item.type === 'mcpApprovalRequest') {
      const call = turn.pendingMcpCall;
      const server = /^mcp__([a-z][a-z0-9]*(?:-[a-z0-9]+)*)__.+$/u.exec(
        lifecycle.params.item.name,
      )?.[1];
      if (
        !call ||
        call.status !== 'completed' ||
        !server ||
        call.callId !== lifecycle.params.item.callId ||
        call.name !== lifecycle.params.item.name ||
        call.argumentsBytes !== lifecycle.params.item.argumentsBytes ||
        call.argumentsSha256 !== lifecycle.params.item.argumentsSha256 ||
        call.inventorySha256 !== lifecycle.params.item.inventorySha256 ||
        call.argumentSignature !== lifecycle.params.item.argumentSignature
      ) {
        throw new Error('MCP approval request did not match its call.');
      }
      const activity: MutableMcpActivity = {
        callItemId: call.id,
        id: lifecycle.params.item.id,
        callId: call.callId,
        approvalId: lifecycle.params.item.approvalId,
        serverId: server,
        name: call.name,
        argumentsBytes: call.argumentsBytes,
        argumentsSha256: call.argumentsSha256,
        inventorySha256: call.inventorySha256,
        argumentSignature: call.argumentSignature,
        callStatus: call.status,
        requestStatus: 'inProgress',
      };
      turn.mcpActivities ??= [];
      turn.mcpActivities.push(activity);
      turn.activities.push({ type: 'mcp', activity });
      turn.pendingMcpCall = undefined;
    } else if (lifecycle.params.item.type === 'mcpApprovalDecision') {
      const activity = this.requireMcpActivityByApproval(
        turn,
        lifecycle.params.item.approvalId,
      );
      if (activity.requestStatus !== 'completed' || activity.decision) {
        throw new Error('MCP approval decision started out of order.');
      }
      activity.decision = {
        id: lifecycle.params.item.id,
        status: 'inProgress',
        value: lifecycle.params.item.decision,
      };
    } else if (lifecycle.params.item.type === 'mcpExecutionAttempt') {
      const activity = this.requireMcpActivityByApproval(
        turn,
        lifecycle.params.item.approvalId,
      );
      if (
        activity.callId !== lifecycle.params.item.callId ||
        activity.inventorySha256 !==
          lifecycle.params.item.inventorySha256 ||
        activity.decision?.status !== 'completed' ||
        activity.decision.value !== 'approved' ||
        activity.executionAttempt
      ) {
        throw new Error('MCP execution attempt started out of order.');
      }
      activity.executionAttempt = {
        id: lifecycle.params.item.id,
        status: 'inProgress',
      };
    } else if (lifecycle.params.item.type === 'mcpResult') {
      const activity = this.requireMcpActivityByCall(
        turn,
        lifecycle.params.item.callId,
      );
      const approved = activity.decision?.value === 'approved';
      if (
        activity.name !== lifecycle.params.item.name ||
        activity.decision?.status !== 'completed' ||
        activity.result ||
        (approved
          ? activity.executionAttempt?.status !== 'completed'
          : Boolean(activity.executionAttempt))
      ) {
        throw new Error('MCP result started out of order.');
      }
      activity.result = {
        id: lifecycle.params.item.id,
        status: 'inProgress',
        receipt: { ...lifecycle.params.item.receipt },
      };
    } else if (lifecycle.params.item.type === 'commandCall') {
      const item = lifecycle.params.item;
      const pendingCalls = (turn.pendingCommandCalls ??= []);
      if (
        pendingCalls.some(
          (call) =>
            call.id === item.id || call.callId === item.callId,
        )
      ) {
        throw new Error('Duplicate command call lifecycle.');
      }
      pendingCalls.push({
        id: item.id,
        callId: item.callId,
        command: item.command,
        arguments: [...item.arguments],
        status: 'inProgress',
      });
    } else if (lifecycle.params.item.type === 'commandApprovalRequest') {
      const item = lifecycle.params.item;
      const call = turn.pendingCommandCalls?.find(
        (candidate) => candidate.callId === item.callId,
      );
      if (
        !call ||
        call.status !== 'completed' ||
        call.callId !== lifecycle.params.item.callId ||
        call.command !== lifecycle.params.item.command ||
        JSON.stringify(call.arguments) !==
          JSON.stringify(lifecycle.params.item.arguments)
      ) {
        throw new Error('Command approval request did not match its call.');
      }
      const activity: MutableCommandApprovalActivity = {
        callItemId: call.id,
        id: lifecycle.params.item.id,
        callId: call.callId,
        approvalId: lifecycle.params.item.approvalId,
        command: call.command,
        argumentCount: call.arguments.length,
        requestStatus: 'inProgress',
        argumentSignature: JSON.stringify(call.arguments),
      };
      turn.commandApproval = activity;
      turn.activities.push({ type: 'commandApproval', activity });
      turn.pendingCommandCalls = turn.pendingCommandCalls?.filter(
        (candidate) => candidate.callId !== call.callId,
      );
    } else if (lifecycle.params.item.type === 'commandApprovalDecision') {
      const activity = this.requireCommandApproval(
        turn,
        lifecycle.params.item.approvalId,
      );
      if (
        activity.requestStatus !== 'completed' ||
        activity.approvalId !== lifecycle.params.item.approvalId ||
        activity.decision
      ) {
        throw new Error('Command approval decision started out of order.');
      }
      activity.decision = {
        id: lifecycle.params.item.id,
        status: 'inProgress',
        value: lifecycle.params.item.decision,
      };
    } else if (lifecycle.params.item.type === 'commandExecutionAttempt') {
      const item = lifecycle.params.item;
      if (
        !this.findCommandApprovalByCall(
          turn,
          item.callId,
        )
      ) {
        const ignoredCall = turn.pendingCommandCalls?.find(
          (candidate) => candidate.callId === item.callId,
        );
        if (
          ignoredCall?.status === 'completed' &&
          ignoredCall.callId === lifecycle.params.item.callId
        ) {
          return;
        }
      }
      const activity = this.requireCommandApproval(
        turn,
        lifecycle.params.item.approvalId,
      );
      if (
        activity.callId !== lifecycle.params.item.callId ||
        activity.requestStatus !== 'completed' ||
        activity.decision?.status !== 'completed' ||
        activity.decision.value !== 'approved' ||
        activity.executionAttempt
      ) {
        throw new Error('Command execution attempt started out of order.');
      }
      activity.executionAttempt = {
        id: lifecycle.params.item.id,
        status: 'inProgress',
      };
    } else {
      const item = lifecycle.params.item;
      const activity = this.findCommandApprovalByCall(
        turn,
        item.callId,
      );
      if (!activity) {
        const ignoredCall = turn.pendingCommandCalls?.find(
          (candidate) => candidate.callId === item.callId,
        );
        if (
          ignoredCall?.status === 'completed' &&
          ignoredCall.callId === lifecycle.params.item.callId
        ) {
          return;
        }
      }
      if (
        activity?.callId === lifecycle.params.item.callId &&
        activity.decision?.status === 'completed' &&
        activity.decision.value !== 'approved' &&
        !activity.executionAttempt
      ) {
        return;
      }
      if (
        !activity ||
        activity.callId !== lifecycle.params.item.callId ||
        activity.decision?.status !== 'completed' ||
        activity.decision.value !== 'approved' ||
        activity.executionAttempt?.status !== 'completed' ||
        activity.executionResult
      ) {
        throw new Error('Command execution result started out of order.');
      }
      activity.executionResult = {
        id: lifecycle.params.item.id,
        status: 'inProgress',
        outcome: { ...lifecycle.params.item.outcome },
      };
    }
    if (
      sourceOutput &&
      lifecycle.params.item.type === 'agentMessage'
    ) {
      return;
    }
    this.publish();
    return;
  };
}
