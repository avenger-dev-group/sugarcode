import type { RuntimeSupervisor } from '../connection/supervisor.ts';
import type { GoalPowerSaveController } from './goals/power-save-controller.ts';
import {
  type ConversationActionResult,
  type ConversationThreadNavigatorSnapshot,
} from '../../../shared/conversation.ts';
import {
  type RuntimeEvent,
  type RuntimeThreadQueue as NativeThreadQueue,
} from '../../../runtime/contracts/protocol.ts';
import type { ConversationProjectionPublisher } from './projection/publisher.ts';
import {
  type GoalCoordinator,
  type GoalQueueOutcome,
} from './goals/coordinator.ts';
import type { ConversationState } from './state.ts';

// Narrow callback ports for collaboration between conversation services.
// Services depend on state and these operations, never on the controller.
export type ConversationServices = Readonly<{
  state: ConversationState;
  runtime: RuntimeSupervisor;
  goals: GoalCoordinator;
  projections: ConversationProjectionPublisher;
  powerSave?: GoalPowerSaveController;
  publish: (source?: string) => void;
  publishThreadProjection: (threadId: string, changed?: boolean, source?: string) => void;
  publishThreadDelta: (threadId: string, turnId: string, source?: string) => void;
  refreshNavigator: (status?: ConversationThreadNavigatorSnapshot['status']) => void;
  ensureSelectedThread: (workspaceId: string) => Promise<string>;
  applyRuntimeQueue: (threadId: string, queue: NativeThreadQueue) => boolean;
  acquireQueueOperation: (threadId: string) => Promise<() => void>;
  queueErrorReason: (error: unknown) => Exclude<ConversationActionResult['reason'], 'accepted'>;
  refreshRuntimeQueue: (threadId: string, workspaceId: string) => Promise<void>;
  appendSteeredUserMessage: (event: Extract<RuntimeEvent, { type: 'turn.steered' }>) => boolean;
  dispatchQueuedMessage: (threadId: string) => Promise<void>;
  finishQueueAfterTurn: (threadId: string, status: 'completed' | 'failed' | 'interrupted') => Promise<GoalQueueOutcome>;
  reconcileGoalAfterRuntimeRestart: (threadId: string) => Promise<void>;
}>;
