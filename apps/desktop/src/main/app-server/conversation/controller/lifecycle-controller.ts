import { ConversationItemCompletedController } from './item-completed';
import {
  appendPendingAgentOutput,
  removePendingAgentOutput,
} from '../agent-output-lifecycle';
import type { ConversationLifecycle } from '../protocol';

export abstract class ConversationLifecycleController extends ConversationItemCompletedController {
  protected applyLifecycle = (lifecycle: ConversationLifecycle): void => {
    switch (lifecycle.type) {
      case 'threadStarted':
        this.requireThread(lifecycle.params.thread.id);
        return;
      case 'turnStarted': {
        this.requireThread(lifecycle.params.threadId);
        this.requireActiveTurn(lifecycle.params.turn.id);
        return;
      }
      case 'itemStarted':
        this.applyItemStarted(lifecycle);
        return;
      case 'tokenUsageUpdated': {
        const turn = this.requireCorrelatedTurn(
          lifecycle.params.threadId,
          lifecycle.params.turnId,
        );
        turn.usage = {
          ...lifecycle.params.usage,
          lastRequest: { ...lifecycle.params.usage.lastRequest },
          turnTotal: { ...lifecycle.params.usage.turnTotal },
        };
        this.publish();
        return;
      }
      case 'warning': {
        this.requireCorrelatedTurn(
          lifecycle.params.threadId,
          lifecycle.params.turnId,
        );
        this.notice = {
          kind: 'warning',
          summary:
            lifecycle.params.code === 'historicalContextDowngraded'
              ? 'Earlier image or PDF content was represented as attachment metadata because the selected model cannot accept that media type.'
              : 'Provider-managed continuation is unsupported by this endpoint. SugarCode continued with private local replay.',
        };
        this.publish();
        return;
      }
      case 'agentOutputDelta': {
        const turn = this.requireCorrelatedTurn(
          lifecycle.params.threadId,
          lifecycle.params.turnId,
        );
        appendPendingAgentOutput(
          turn.pendingAgentOutputs,
          lifecycle.params.output,
          lifecycle.params.delta,
        );
        this.publish();
        return;
      }
      case 'agentOutputDiscarded': {
        const turn = this.requireCorrelatedTurn(
          lifecycle.params.threadId,
          lifecycle.params.turnId,
        );
        removePendingAgentOutput(
          turn.pendingAgentOutputs,
          lifecycle.params.output,
        );
        this.publish();
        return;
      }
      case 'agentDelta': {
        const turn = this.requireCorrelatedTurn(
          lifecycle.params.threadId,
          lifecycle.params.turnId,
        );
        const message = this.requireMessage(turn, lifecycle.params.itemId);
        if (message.role !== 'agent' || message.status !== 'inProgress') {
          throw new Error('Agent delta did not match an active AgentMessage.');
        }
        if (message.agentOutput) {
          removePendingAgentOutput(
            turn.pendingAgentOutputs,
            message.agentOutput,
          );
          delete message.agentOutput;
        }
        message.text += lifecycle.params.delta;
        this.publish();
        return;
      }
      case 'itemCompleted':
        this.applyItemCompleted(lifecycle);
        return;
      case 'turnCompleted': {
        const turn = this.requireCorrelatedTurn(
          lifecycle.params.threadId,
          lifecycle.params.turn.id,
        );
        if (
          lifecycle.params.turn.status === 'completed' &&
          turn.pendingAgentOutputs.length > 0
        ) {
          throw new Error('Turn completed with unresolved Agent output.');
        }
        turn.pendingAgentOutputs = [];
        for (const message of turn.messages) {
          delete message.agentOutput;
        }
        if (turn.messages.some((message) => message.status !== 'completed')) {
          throw new Error('Turn completed before all text Items completed.');
        }
        if (
          turn.contextCompactions?.some(
            (activity) => activity.status !== 'completed' || !activity.outcome,
          )
        ) {
          throw new Error(
            'Turn completed before context compaction activity completed.',
          );
        }
        if (
          turn.activities.some(
            (entry) =>
              entry.type === 'workspaceRead' &&
              (entry.activity.callStatus !== 'completed' ||
                (lifecycle.params.turn.status !== 'interrupted' &&
                  entry.activity.result?.status !== 'completed') ||
                (entry.activity.result &&
                  entry.activity.result.status !== 'completed')),
          )
        ) {
          throw new Error(
            'Turn completed before workspace/read activity completed.',
          );
        }
        if (
          turn.activities.some(
            (entry) =>
              entry.type === 'workspaceList' &&
              (entry.activity.callStatus !== 'completed' ||
                (lifecycle.params.turn.status !== 'interrupted' &&
                  entry.activity.result?.status !== 'completed') ||
                (entry.activity.result &&
                  entry.activity.result.status !== 'completed')),
          )
        ) {
          throw new Error(
            'Turn completed before workspace/list activity completed.',
          );
        }
        if (
          turn.activities.some(
            (entry) =>
              entry.type === 'workspaceSearch' &&
              (entry.activity.callStatus !== 'completed' ||
                (lifecycle.params.turn.status !== 'interrupted' &&
                  entry.activity.result?.status !== 'completed') ||
                (entry.activity.result &&
                  entry.activity.result.status !== 'completed')),
          )
        ) {
          throw new Error(
            'Turn completed before workspace/search activity completed.',
          );
        }
        if (
          turn.fileChange &&
          (turn.fileChange.callStatus !== 'completed' ||
            (turn.fileChange.change &&
              turn.fileChange.change.status !== 'completed') ||
            (turn.fileChange.result &&
              turn.fileChange.result.status !== 'completed') ||
            (lifecycle.params.turn.status !== 'interrupted' &&
              turn.fileChange.result?.status !== 'completed'))
        ) {
          throw new Error(
            'Turn completed before workspace/apply-diff activity completed.',
          );
        }
        if (
          (lifecycle.params.turn.status !== 'interrupted' &&
            (turn.pendingCommandCalls?.length ?? 0) > 0) ||
          turn.activities.some(
            (entry) =>
              entry.type === 'commandApproval' &&
              (entry.activity.requestStatus !== 'completed' ||
                (lifecycle.params.turn.status !== 'interrupted' &&
                  entry.activity.decision?.status !== 'completed') ||
                (entry.activity.decision &&
                  entry.activity.decision.status !== 'completed') ||
                (entry.activity.executionAttempt &&
                  entry.activity.executionAttempt.status !== 'completed') ||
                (entry.activity.executionResult &&
                  entry.activity.executionResult.status !== 'completed') ||
                (lifecycle.params.turn.status !== 'interrupted' &&
                  entry.activity.executionAttempt &&
                  entry.activity.executionResult?.status !== 'completed')),
          )
        ) {
          throw new Error(
            'Turn completed before command approval activity completed.',
          );
        }
        if (
          turn.pendingMcpCall ||
          turn.mcpActivities?.some(
            (activity) =>
              activity.callStatus !== 'completed' ||
              activity.requestStatus !== 'completed' ||
              (activity.decision && activity.decision.status !== 'completed') ||
              (activity.executionAttempt &&
                activity.executionAttempt.status !== 'completed') ||
              (activity.result && activity.result.status !== 'completed') ||
              (lifecycle.params.turn.status !== 'interrupted' &&
                (!activity.decision || !activity.result)),
          )
        ) {
          throw new Error('Turn completed before MCP activity completed.');
        }
        turn.status = lifecycle.params.turn.status;
        turn.error = lifecycle.params.turn.error;
        this.activeTurnId = null;
        this.phase = 'ready';
        this.actionAbortController = null;
        this.publish();
      }
    }
  };


}
