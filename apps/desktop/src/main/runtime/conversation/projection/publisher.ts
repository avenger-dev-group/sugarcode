import {
  isConversationStateSnapshot,
  isConversationThreadProjectionDelta,
  isConversationThreadProjectionSnapshot,
  type ConversationStateListener,
  type ConversationStateSnapshot,
  type ConversationThreadDeltaListener,
  type ConversationThreadProjectionDelta,
  type ConversationThreadProjectionListener,
  type ConversationThreadProjectionSnapshot,
} from '../../../../shared/conversation.ts';

export type ConversationProjectionFault = Readonly<{
  kind:
    | 'invalidStateSnapshot'
    | 'invalidThreadSnapshot'
    | 'invalidThreadDelta'
    | 'listenerFailed';
  projection: 'state' | 'threadSnapshot' | 'threadDelta';
  revision: number;
  source: string;
  threadId?: string;
  turnId?: string;
  phase?: string;
  activeTurnId?: string;
  turnStatus?: string;
  hasUsage?: boolean;
  needsRecovery?: boolean;
  listenerError?: string;
}>;

type ConversationProjectionPublisherOptions = Readonly<{
  buildStateSnapshot: (revision: number) => ConversationStateSnapshot;
  buildThreadSnapshot: (
    threadId: string,
    revision: number,
  ) => ConversationThreadProjectionSnapshot | null;
  onFault: (fault: ConversationProjectionFault) => void;
}>;

export class ConversationProjectionPublisher {
  private readonly options: ConversationProjectionPublisherOptions;
  private readonly stateListeners = new Set<ConversationStateListener>();
  private readonly threadSnapshotListeners =
    new Set<ConversationThreadProjectionListener>();
  private readonly threadDeltaListeners =
    new Set<ConversationThreadDeltaListener>();
  private readonly threadRevisions = new Map<string, number>();
  private stateRevision = 0;

  constructor(options: ConversationProjectionPublisherOptions) {
    this.options = options;
  }

  get revision(): number {
    return this.stateRevision;
  }

  threadRevision = (threadId: string): number =>
    this.threadRevisions.get(threadId) ?? 0;

  forgetThread = (threadId: string): void => {
    this.threadRevisions.delete(threadId);
  };

  subscribeState = (listener: ConversationStateListener): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  subscribeThreadSnapshot = (
    listener: ConversationThreadProjectionListener,
  ): (() => void) => {
    this.threadSnapshotListeners.add(listener);
    return () => this.threadSnapshotListeners.delete(listener);
  };

  subscribeThreadDelta = (
    listener: ConversationThreadDeltaListener,
  ): (() => void) => {
    this.threadDeltaListeners.add(listener);
    return () => this.threadDeltaListeners.delete(listener);
  };

  publishState = (source: string): boolean => {
    const revision = this.stateRevision + 1;
    const snapshot = this.options.buildStateSnapshot(revision);
    if (!isConversationStateSnapshot(snapshot)) {
      const rejected = snapshot as unknown as Record<string, unknown>;
      this.reportFault({
        kind: 'invalidStateSnapshot',
        projection: 'state',
        revision,
        source,
        ...(typeof rejected.phase === 'string'
          ? { phase: rejected.phase }
          : {}),
        ...(typeof rejected.activeTurnId === 'string'
          ? { activeTurnId: rejected.activeTurnId }
          : {}),
      });
      return false;
    }
    this.stateRevision = revision;
    this.notify(this.stateListeners, snapshot, {
      projection: 'state',
      revision,
      source,
    });
    return true;
  };

  publishThreadSnapshot = (
    threadId: string,
    changed: boolean,
    source: string,
  ): boolean => {
    const currentRevision = this.threadRevision(threadId);
    const revision = changed ? currentRevision + 1 : currentRevision;
    const snapshot = this.options.buildThreadSnapshot(threadId, revision);
    if (!snapshot) {
      return false;
    }
    if (!isConversationThreadProjectionSnapshot(snapshot)) {
      this.reportFault({
        kind: 'invalidThreadSnapshot',
        needsRecovery: true,
        projection: 'threadSnapshot',
        revision,
        source,
        ...this.threadFaultContext(snapshot, threadId),
      });
      return false;
    }
    if (changed) {
      this.threadRevisions.set(threadId, revision);
    }
    this.notify(this.threadSnapshotListeners, snapshot, {
      projection: 'threadSnapshot',
      revision,
      source,
      threadId,
    });
    return true;
  };

  publishThreadDelta = (
    threadId: string,
    turnId: string,
    source: string,
  ): boolean => {
    const revision = this.threadRevision(threadId) + 1;
    const snapshot = this.options.buildThreadSnapshot(threadId, revision);
    const turn = snapshot?.turns.find((candidate) => candidate.id === turnId);
    if (!snapshot || !turn) {
      return false;
    }
    const delta: ConversationThreadProjectionDelta = {
      revision,
      workspaceId: snapshot.workspaceId,
      threadId,
      phase: snapshot.phase,
      ...(snapshot.activeTurnId
        ? { activeTurnId: snapshot.activeTurnId }
        : {}),
      turn,
    };
    if (!isConversationThreadProjectionDelta(delta)) {
      const snapshotValid = isConversationThreadProjectionSnapshot(snapshot);
      this.reportFault({
        kind: 'invalidThreadDelta',
        needsRecovery: !snapshotValid,
        projection: 'threadDelta',
        revision,
        source,
        ...this.threadFaultContext(snapshot, threadId, turnId),
      });
      // A delta has stricter active-Turn constraints than an authoritative
      // snapshot. Prefer a validated full snapshot when only the delta shape is
      // unusable, so renderers can recover without a revision gap.
      if (snapshotValid) {
        this.threadRevisions.set(threadId, revision);
        this.notify(this.threadSnapshotListeners, snapshot, {
          projection: 'threadSnapshot',
          revision,
          source: `${source}:deltaFallback`,
          threadId,
          turnId,
        });
        return true;
      }
      return false;
    }
    this.threadRevisions.set(threadId, revision);
    this.notify(this.threadDeltaListeners, delta, {
      projection: 'threadDelta',
      revision,
      source,
      threadId,
      turnId,
    });
    return true;
  };

  private threadFaultContext = (
    snapshot: ConversationThreadProjectionSnapshot,
    threadId: string,
    turnId?: string,
  ): Pick<
    ConversationProjectionFault,
    'threadId' | 'turnId' | 'phase' | 'activeTurnId' | 'turnStatus' | 'hasUsage'
  > => {
    const turn = turnId
      ? snapshot.turns.find((candidate) => candidate.id === turnId)
      : undefined;
    return {
      threadId,
      ...(turnId ? { turnId } : {}),
      phase: snapshot.phase,
      ...(snapshot.activeTurnId
        ? { activeTurnId: snapshot.activeTurnId }
        : {}),
      ...(turn
        ? { turnStatus: turn.status, hasUsage: turn.usage !== undefined }
        : {}),
    };
  };

  private notify = <T>(
    listeners: ReadonlySet<(value: T) => void>,
    value: T,
    context: Omit<ConversationProjectionFault, 'kind' | 'listenerError'>,
  ): void => {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        this.reportFault({
          kind: 'listenerFailed',
          ...context,
          listenerError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  private reportFault = (fault: ConversationProjectionFault): void => {
    try {
      this.options.onFault(fault);
    } catch {
      // A diagnostic/recovery hook must not reopen the IPC exception boundary.
      process.stderr.write(`[SugarCode projection diagnostic failed] ${fault.kind}\n`);
    }
  };
}
