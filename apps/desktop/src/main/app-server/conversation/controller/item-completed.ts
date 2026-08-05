import type { ConversationLifecycle } from '../protocol';
import {
  commandExecutionOutcomesEqual,
  fileChangeProposalsEqual,
  fileChangeResultsEqual,
  listOutcomesEqual,
  outcomesEqual,
  searchOutcomesEqual,
  toFileChangeProposal,
} from './lifecycle-comparison';
import { ConversationItemStartedController } from './item-started';
import type { MutableConversationActivity } from './mutable-state';

export abstract class ConversationItemCompletedController extends ConversationItemStartedController {
  protected applyItemCompleted = (
    lifecycle: Extract<ConversationLifecycle, { type: 'itemCompleted' }>,
  ): void => {
    const turn = this.requireCorrelatedTurn(
      lifecycle.params.threadId,
      lifecycle.params.turnId,
    );
    if (
      lifecycle.params.item.type === 'userMessage' ||
      lifecycle.params.item.type === 'agentMessage'
    ) {
      const message = this.requireMessage(turn, lifecycle.params.item.id);
      const role =
        lifecycle.params.item.type === 'userMessage' ? 'user' : 'agent';
      if (message.role !== role || message.status !== 'inProgress') {
        throw new Error('Completed Item did not match its started Item.');
      }
      if (message.agentOutput) {
        throw new Error('AgentMessage completed before output resolution.');
      }
      message.text = lifecycle.params.item.text;
      if (lifecycle.params.item.type === 'userMessage') {
        message.attachments = this.withAttachmentPreviews(
          lifecycle.params.item.attachments,
        );
        for (const attachment of lifecycle.params.item.attachments) {
          this.attachmentPreviews.delete(attachment.assetId);
        }
      }
      message.status = 'completed';
    } else if (lifecycle.params.item.type === 'agentCommentary') {
      const commentary = turn.activities.find(
        (
          entry,
        ): entry is Extract<
          MutableConversationActivity,
          { type: 'commentary' }
        > =>
          entry.type === 'commentary' &&
          entry.activity.id === lifecycle.params.item.id,
      );
      if (!commentary || commentary.activity.status !== 'inProgress') {
        throw new Error(
          'Completed Commentary did not match its started Item.',
        );
      }
      commentary.activity.text = lifecycle.params.item.text;
      commentary.activity.status = 'completed';
    } else if (lifecycle.params.item.type === 'contextCompaction') {
      const activity = turn.contextCompactions?.find(
        (candidate) => candidate.id === lifecycle.params.item.id,
      );
      if (
        !activity ||
        activity.status !== 'inProgress' ||
        !lifecycle.params.item.outcome ||
        activity.ordinal !== lifecycle.params.item.ordinal ||
        activity.preContextBytes !==
          lifecycle.params.item.preContextBytes ||
        activity.sourceMessages !== lifecycle.params.item.sourceMessages ||
        activity.sourceBytes !== lifecycle.params.item.sourceBytes ||
        activity.sourceSha256 !== lifecycle.params.item.sourceSha256
      ) {
        throw new Error(
          'Completed context compaction did not match its started Item.',
        );
      }
      activity.status = 'completed';
      activity.outcome = lifecycle.params.item.outcome;
    } else if (lifecycle.params.item.type === 'workspaceReadCall') {
      const workspaceRead = this.requireWorkspaceRead(
        turn,
        lifecycle.params.item.callId,
      );
      if (
        workspaceRead.id !== lifecycle.params.item.id ||
        workspaceRead.path !== lifecycle.params.item.path ||
        workspaceRead.callStatus !== 'inProgress'
      ) {
        throw new Error(
          'Completed workspace/read call did not match its started Item.',
        );
      }
      workspaceRead.callStatus = 'completed';
    } else if (lifecycle.params.item.type === 'workspaceReadResult') {
      const workspaceRead = this.requireWorkspaceRead(
        turn,
        lifecycle.params.item.callId,
      );
      const result = workspaceRead.result;
      if (
        !result ||
        result.id !== lifecycle.params.item.id ||
        result.status !== 'inProgress' ||
        !outcomesEqual(result.outcome, lifecycle.params.item.outcome)
      ) {
        throw new Error(
          'Completed workspace/read result did not match its started Item.',
        );
      }
      result.status = 'completed';
    } else if (lifecycle.params.item.type === 'workspaceListCall') {
      const workspaceList = this.requireWorkspaceList(
        turn,
        lifecycle.params.item.callId,
      );
      if (
        workspaceList.id !== lifecycle.params.item.id ||
        workspaceList.path !== lifecycle.params.item.path ||
        workspaceList.callStatus !== 'inProgress'
      ) {
        throw new Error(
          'Completed workspace/list call did not match its started Item.',
        );
      }
      workspaceList.callStatus = 'completed';
    } else if (lifecycle.params.item.type === 'workspaceListResult') {
      const workspaceList = this.requireWorkspaceList(
        turn,
        lifecycle.params.item.callId,
      );
      const result = workspaceList.result;
      if (
        !result ||
        result.id !== lifecycle.params.item.id ||
        result.status !== 'inProgress' ||
        !listOutcomesEqual(result.outcome, lifecycle.params.item.outcome)
      ) {
        throw new Error(
          'Completed workspace/list result did not match its started Item.',
        );
      }
      result.status = 'completed';
    } else if (lifecycle.params.item.type === 'workspaceSearchCall') {
      const workspaceSearch = this.requireWorkspaceSearch(
        turn,
        lifecycle.params.item.callId,
      );
      if (
        workspaceSearch.id !== lifecycle.params.item.id ||
        workspaceSearch.path !== lifecycle.params.item.path ||
        workspaceSearch.query !== lifecycle.params.item.query ||
        workspaceSearch.callStatus !== 'inProgress'
      ) {
        throw new Error(
          'Completed workspace/search call did not match its started Item.',
        );
      }
      workspaceSearch.callStatus = 'completed';
    } else if (lifecycle.params.item.type === 'workspaceSearchResult') {
      const workspaceSearch = this.requireWorkspaceSearch(
        turn,
        lifecycle.params.item.callId,
      );
      const result = workspaceSearch.result;
      if (
        !result ||
        result.id !== lifecycle.params.item.id ||
        result.status !== 'inProgress' ||
        !searchOutcomesEqual(result.outcome, lifecycle.params.item.outcome)
      ) {
        throw new Error(
          'Completed workspace/search result did not match its started Item.',
        );
      }
      result.status = 'completed';
    } else if (lifecycle.params.item.type === 'workspacePatchCall') {
      const activity = this.requireFileChange(
        turn,
        lifecycle.params.item.callId,
      );
      if (
        activity.id !== lifecycle.params.item.id ||
        activity.path !== lifecycle.params.item.path ||
        activity.callStatus !== 'inProgress'
      ) {
        throw new Error(
          'Completed workspace/apply-diff call did not match its started Item.',
        );
      }
      activity.callStatus = 'completed';
    } else if (lifecycle.params.item.type === 'workspacePatchChange') {
      const activity = this.requireFileChange(
        turn,
        lifecycle.params.item.callId,
      );
      const changeIndex = activity.changes.findIndex(
        (change) => change.id === lifecycle.params.item.id,
      );
      const change = activity.changes[changeIndex];
      if (
        !change ||
        change.status !== 'inProgress' ||
        !fileChangeProposalsEqual(
          change,
          toFileChangeProposal(lifecycle.params.item),
        )
      ) {
        throw new Error(
          'Completed FileChange did not match its started Item.',
        );
      }
      activity.changes[changeIndex] = {
        ...change,
        status: 'completed',
      };
      if (activity.change?.id === change.id) {
        activity.change = activity.changes[changeIndex];
      }
    } else if (lifecycle.params.item.type === 'workspacePatchResult') {
      const activity = this.requireFileChange(
        turn,
        lifecycle.params.item.callId,
      );
      const result = activity.result;
      if (
        !result ||
        result.id !== lifecycle.params.item.id ||
        result.status !== 'inProgress' ||
        !fileChangeResultsEqual(
          result.outcome,
          lifecycle.params.item.outcome,
        )
      ) {
        throw new Error(
          'Completed workspace/apply-diff result did not match its started Item.',
        );
      }
      result.status = 'completed';
    } else if (lifecycle.params.item.type === 'mcpCall') {
      const call = turn.pendingMcpCall;
      if (
        !call ||
        call.id !== lifecycle.params.item.id ||
        call.callId !== lifecycle.params.item.callId ||
        call.name !== lifecycle.params.item.name ||
        call.argumentsBytes !== lifecycle.params.item.argumentsBytes ||
        call.argumentsSha256 !== lifecycle.params.item.argumentsSha256 ||
        call.inventorySha256 !== lifecycle.params.item.inventorySha256 ||
        call.argumentSignature !==
          lifecycle.params.item.argumentSignature ||
        call.status !== 'inProgress'
      ) {
        throw new Error(
          'Completed MCP call did not match its started Item.',
        );
      }
      call.status = 'completed';
    } else if (lifecycle.params.item.type === 'mcpApprovalRequest') {
      const activity = this.requireMcpActivityByApproval(
        turn,
        lifecycle.params.item.approvalId,
      );
      if (
        activity.id !== lifecycle.params.item.id ||
        activity.callId !== lifecycle.params.item.callId ||
        activity.name !== lifecycle.params.item.name ||
        activity.argumentsBytes !== lifecycle.params.item.argumentsBytes ||
        activity.argumentsSha256 !==
          lifecycle.params.item.argumentsSha256 ||
        activity.inventorySha256 !==
          lifecycle.params.item.inventorySha256 ||
        activity.argumentSignature !==
          lifecycle.params.item.argumentSignature ||
        activity.requestStatus !== 'inProgress'
      ) {
        throw new Error(
          'Completed MCP approval request did not match its started Item.',
        );
      }
      activity.requestStatus = 'completed';
    } else if (lifecycle.params.item.type === 'mcpApprovalDecision') {
      const activity = this.requireMcpActivityByApproval(
        turn,
        lifecycle.params.item.approvalId,
      );
      const decision = activity.decision;
      if (
        !decision ||
        decision.id !== lifecycle.params.item.id ||
        decision.status !== 'inProgress' ||
        decision.value !== lifecycle.params.item.decision
      ) {
        throw new Error(
          'Completed MCP approval decision did not match its started Item.',
        );
      }
      decision.status = 'completed';
    } else if (lifecycle.params.item.type === 'mcpExecutionAttempt') {
      const activity = this.requireMcpActivityByApproval(
        turn,
        lifecycle.params.item.approvalId,
      );
      const attempt = activity.executionAttempt;
      if (
        activity.callId !== lifecycle.params.item.callId ||
        activity.inventorySha256 !==
          lifecycle.params.item.inventorySha256 ||
        !attempt ||
        attempt.id !== lifecycle.params.item.id ||
        attempt.status !== 'inProgress'
      ) {
        throw new Error(
          'Completed MCP execution attempt did not match its started Item.',
        );
      }
      attempt.status = 'completed';
    } else if (lifecycle.params.item.type === 'mcpResult') {
      const activity = this.requireMcpActivityByCall(
        turn,
        lifecycle.params.item.callId,
      );
      const result = activity.result;
      if (
        activity.name !== lifecycle.params.item.name ||
        !result ||
        result.id !== lifecycle.params.item.id ||
        result.status !== 'inProgress' ||
        JSON.stringify(result.receipt) !==
          JSON.stringify(lifecycle.params.item.receipt)
      ) {
        throw new Error(
          'Completed MCP result did not match its started Item.',
        );
      }
      result.status = 'completed';
    } else if (
      lifecycle.params.item.type === 'agentTask' ||
      lifecycle.params.item.type === 'agentTaskAmendment' ||
      lifecycle.params.item.type === 'agentTaskResult'
    ) {
      // Collaboration records are append-only and become visible on
      // item/started. Completion carries the same immutable payload.
    } else if (lifecycle.params.item.type === 'commandCall') {
      const item = lifecycle.params.item;
      const call = turn.pendingCommandCalls?.find(
        (candidate) => candidate.callId === item.callId,
      );
      if (
        !call ||
        call.id !== lifecycle.params.item.id ||
        call.callId !== lifecycle.params.item.callId ||
        call.command !== lifecycle.params.item.command ||
        JSON.stringify(call.arguments) !==
          JSON.stringify(lifecycle.params.item.arguments) ||
        call.status !== 'inProgress'
      ) {
        throw new Error(
          'Completed command call did not match its started Item.',
        );
      }
      call.status = 'completed';
    } else if (lifecycle.params.item.type === 'commandApprovalRequest') {
      const activity = this.requireCommandApproval(
        turn,
        lifecycle.params.item.approvalId,
      );
      if (
        activity.id !== lifecycle.params.item.id ||
        activity.callId !== lifecycle.params.item.callId ||
        activity.command !== lifecycle.params.item.command ||
        activity.argumentSignature !==
          JSON.stringify(lifecycle.params.item.arguments) ||
        activity.requestStatus !== 'inProgress'
      ) {
        throw new Error(
          'Completed command approval request did not match its started Item.',
        );
      }
      activity.requestStatus = 'completed';
    } else if (lifecycle.params.item.type === 'commandApprovalDecision') {
      const activity = this.requireCommandApproval(
        turn,
        lifecycle.params.item.approvalId,
      );
      const decision = activity.decision;
      if (
        activity.approvalId !== lifecycle.params.item.approvalId ||
        !decision ||
        decision.id !== lifecycle.params.item.id ||
        decision.status !== 'inProgress' ||
        decision.value !== lifecycle.params.item.decision
      ) {
        throw new Error(
          'Completed command approval decision did not match its started Item.',
        );
      }
      decision.status = 'completed';
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
      const executionAttempt = activity.executionAttempt;
      if (
        activity.callId !== lifecycle.params.item.callId ||
        !executionAttempt ||
        executionAttempt.id !== lifecycle.params.item.id ||
        executionAttempt.status !== 'inProgress'
      ) {
        throw new Error(
          'Completed command execution attempt did not match its started Item.',
        );
      }
      executionAttempt.status = 'completed';
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
      const executionResult = activity?.executionResult;
      if (
        !activity ||
        activity.callId !== lifecycle.params.item.callId ||
        !executionResult ||
        executionResult.id !== lifecycle.params.item.id ||
        executionResult.status !== 'inProgress' ||
        !commandExecutionOutcomesEqual(
          executionResult.outcome,
          lifecycle.params.item.outcome,
        )
      ) {
        throw new Error(
          'Completed command execution result did not match its started Item.',
        );
      }
      executionResult.status = 'completed';
    }
    this.publish();
    return;
  };
}
