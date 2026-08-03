import type { ConversationStateSnapshot } from '@/shared/conversation';

import type { ConversationLifecycle } from '../protocol';
import { ConversationLifecycleController } from './lifecycle-controller';
import type { MutableTurn } from './mutable-state';

const MAX_BUFFERED_LIFECYCLE = 64;

export type TurnStartAcceptance =
  | 'idle'
  | 'pending'
  | 'accepted'
  | 'failed';

export type ThreadRuntimeState = Readonly<{
  workspaceId: string;
  threadId: string;
  phase: ConversationStateSnapshot['phase'];
  activeTurnId: string | null;
  turns: MutableTurn[];
  notice: ConversationStateSnapshot['notice'];
  attachmentPreviews: ReadonlyMap<string, string>;
}>;

export class ThreadRuntime extends ConversationLifecycleController {
  readonly workspaceId: string;
  private lifecycleBuffer: ConversationLifecycle[] = [];
  private turnStartAcceptance: TurnStartAcceptance = 'idle';

  constructor(state: ThreadRuntimeState) {
    super();
    this.workspaceId = state.workspaceId;
    this.threadId = state.threadId;
    this.phase = state.phase;
    this.activeTurnId = state.activeTurnId;
    this.turns = state.turns;
    this.notice = state.notice;
    for (const [assetId, preview] of state.attachmentPreviews) {
      this.attachmentPreviews.set(assetId, preview);
    }
  }

  acceptLifecycle = (lifecycle: ConversationLifecycle): void => {
    this.applyLifecycle(lifecycle);
  };

  replaceProjection = (state: ThreadRuntimeState): void => {
    if (
      state.workspaceId !== this.workspaceId ||
      state.threadId !== this.threadId
    ) {
      throw new Error('Thread Runtime binding is immutable.');
    }
    this.phase = state.phase;
    this.activeTurnId = state.activeTurnId;
    this.turns = state.turns;
    this.notice = state.notice;
    this.attachmentPreviews.clear();
    for (const [assetId, preview] of state.attachmentPreviews) {
      this.attachmentPreviews.set(assetId, preview);
    }
  };

  beginTurnStart = (): void => {
    this.lifecycleBuffer = [];
    this.turnStartAcceptance = 'pending';
  };

  bufferLifecycle = (lifecycle: ConversationLifecycle): void => {
    if (
      this.turnStartAcceptance !== 'pending' ||
      this.lifecycleBuffer.length >= MAX_BUFFERED_LIFECYCLE
    ) {
      throw new Error('Thread Runtime lifecycle buffer is unavailable.');
    }
    this.lifecycleBuffer.push(lifecycle);
  };

  isTurnStartPending = (): boolean =>
    this.turnStartAcceptance === 'pending';

  acceptTurnStart = (): ConversationLifecycle[] => {
    if (this.turnStartAcceptance !== 'pending') {
      throw new Error('Thread Runtime Turn start was not pending.');
    }
    this.turnStartAcceptance = 'accepted';
    const buffered = this.lifecycleBuffer;
    this.lifecycleBuffer = [];
    return buffered;
  };

  failTurnStart = (): void => {
    this.turnStartAcceptance = 'failed';
    this.lifecycleBuffer = [];
  };

  resetTurnStart = (): void => {
    this.turnStartAcceptance = 'idle';
    this.lifecycleBuffer = [];
  };

  getPhase = (): ConversationStateSnapshot['phase'] => this.phase;

  setPhase = (phase: ConversationStateSnapshot['phase']): void => {
    this.phase = phase;
  };

  getActiveTurnId = (): string | null => this.activeTurnId;

  getTurns = (): MutableTurn[] => this.turns;

  capture = (): ThreadRuntimeState => ({
    workspaceId: this.workspaceId,
    threadId: this.threadId as string,
    phase: this.phase,
    activeTurnId: this.activeTurnId,
    turns: this.turns,
    notice: this.notice,
    attachmentPreviews: new Map(this.attachmentPreviews),
  });

  protected publish = (): void => undefined;
}
