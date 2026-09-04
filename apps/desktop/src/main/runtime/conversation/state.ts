import {
  type ConversationStateSnapshot,
  type ConversationThreadQueue,
  type ConversationTurn,
} from '../../../shared/conversation.ts';
import {
  type RuntimeThreadRecord,
  type RuntimeThreadQueue as NativeThreadQueue,
} from '../../../runtime/contracts/protocol.ts';
import { emptyNavigator } from './navigation/state.ts';

// In-memory state for one controller instance, shared by its services. Keep
// requests, timers, subscriptions and business operations out of this store.
export class ConversationState {
  readonly threadRecords = new Map<string, RuntimeThreadRecord>();
  readonly turnsByThread = new Map<string, ConversationTurn[]>();
  readonly queuesByThread = new Map<string, ConversationThreadQueue>();
  readonly runtimeQueuesByThread = new Map<string, NativeThreadQueue>();
  readonly promotingQueueItemsByThread = new Map<string, string>();
  readonly unreadThreadStatuses = new Map<
    string,
    'completed' | 'failed' | 'interrupted'
  >();
  /** Scheduled runs stay reviewable without appearing in normal task navigation. */
  readonly scheduledThreadIds = new Set<string>();
  readonly activeTurnsByThread = new Map<
    string,
    Readonly<{
      workspaceId: string;
      turnId: string;
      phase: Extract<
        ConversationStateSnapshot['phase'],
        'starting' | 'inProgress' | 'stopping'
      >;
      goalId?: string;
    }>
  >();
  readonly pendingTurnStartWorkspaces = new Set<string>();
  readonly goalReconciliationThreads = new Set<string>();
  workspaceId: string | null = null;
  workspaceGeneration = 0;
  threadSelectionGeneration = 0;
  available = false;
  threadId: string | null = null;
  navigator = emptyNavigator();
  notice: ConversationStateSnapshot['notice'];
}
