import type {
  CommandApprovalParams,
  CommandApprovalResponseDecision,
  RequestId,
} from '@sugarcode/app-server-protocol';
import { randomUUID } from 'node:crypto';

import type {
  CommandApprovalActionResult,
  CommandApprovalMode,
  CommandApprovalStateListener,
  CommandApprovalStateSnapshot,
  CommandApprovalStatus,
  CommandApprovalViewModel,
} from '@/shared/command-approval';

import {
  isCommandApprovalCompletionCandidate,
  parseCommandApprovalCompletion,
  parseCommandApprovalRequest,
} from './protocol';
import {
  createCommandApprovalModeScope,
  evaluateAutomaticCommandApproval,
  type CommandApprovalModeScope,
} from './mode-policy';
import type { ServerMessage } from '../transport/server-message';

const LOCAL_APPROVAL_WINDOW_MS = 120_000;

type CommandApprovalControllerOptions = Readonly<{
  platform?: NodeJS.Platform;
  now?: () => number;
  createPresentationId?: () => string;
  writeDecision: (
    requestId: RequestId,
    decision: CommandApprovalResponseDecision,
  ) => Promise<void>;
  onProtocolFailure: () => void;
  onWriteFailure: () => void;
  onSurfaceFailure: () => void;
  onSurfaceReady?: () => void;
  getQueueCount?: () => number;
  describeSource?: (threadId: string) => Readonly<{
    projectTitle: string;
    conversationTitle: string;
  }>;
  getWorkspaceScope?: (threadId: string) => string | null;
}>;

type ActiveApproval = {
  requestId: RequestId;
  params: CommandApprovalParams;
  presentationId: string;
  localExpiresAtMs: number;
  actionState: CommandApprovalViewModel['actionState'];
  responseCommitted: boolean;
  timer: ReturnType<typeof setTimeout>;
};

const actionResult = (
  reason: CommandApprovalActionResult['reason'],
): CommandApprovalActionResult => ({
  accepted: reason === 'accepted',
  reason,
});

export class CommandApprovalController {
  private readonly options: Required<
    Pick<
      CommandApprovalControllerOptions,
      'platform' | 'now' | 'createPresentationId'
    >
  > &
    Omit<
      CommandApprovalControllerOptions,
      'platform' | 'now' | 'createPresentationId'
    >;
  private readonly listeners = new Set<CommandApprovalStateListener>();
  private snapshot: CommandApprovalStateSnapshot = {
    revision: 0,
    status: 'idle',
    mode: 'ask',
  };
  private active: ActiveApproval | null = null;
  private modeScope: CommandApprovalModeScope =
    createCommandApprovalModeScope('ask');
  private surfaceReady = false;
  private closed = false;

  constructor(options: CommandApprovalControllerOptions) {
    this.options = {
      ...options,
      platform: options.platform ?? process.platform,
      now: options.now ?? Date.now,
      createPresentationId: options.createPresentationId ?? randomUUID,
    };
  }

  getSnapshot = (): CommandApprovalStateSnapshot => this.snapshot;

  queueChanged = (): void => {
    if (this.active && this.snapshot.status === 'pending') {
      this.transition('pending', this.toViewModel(this.active));
    }
  };

  subscribe = (listener: CommandApprovalStateListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  markSurfaceReady = (): CommandApprovalStateSnapshot => {
    this.surfaceReady = true;
    this.options.onSurfaceReady?.();
    return this.snapshot;
  };

  isSurfaceReady = (): boolean => this.surfaceReady;

  handleServerRequest = (
    request: Extract<ServerMessage, { kind: 'request' }>,
  ): void => {
    if (
      request.method !== 'item/commandExecution/requestApproval' ||
      this.closed
    ) {
      this.options.onProtocolFailure();
      return;
    }
    const params = parseCommandApprovalRequest(
      request.id,
      request.params,
      this.options.platform,
    );
    if (!params) {
      void this.denyThenFail(request.id, this.options.onProtocolFailure);
      return;
    }
    if (params.workspaceWritePolicy === 'commandWorkspaceWriteV1') {
      void this.writeDecision(request.id, 'denied');
      return;
    }
    if (this.options.platform === 'win32') {
      void this.denyThenFail(request.id, this.options.onProtocolFailure);
      return;
    }
    if (this.shouldApproveAutomatically(params.threadId)) {
      void this.approveAutomatically(request.id);
      return;
    }
    if (!this.surfaceReady || this.active) {
      void this.writeDecision(request.id, 'denied');
      return;
    }

    const localExpiresAtMs =
      this.options.now() + LOCAL_APPROVAL_WINDOW_MS;
    const active: ActiveApproval = {
      requestId: request.id,
      params,
      presentationId: this.options.createPresentationId(),
      localExpiresAtMs,
      actionState: 'awaitingUser',
      responseCommitted: false,
      timer: setTimeout(() => {
        if (this.active !== active || active.responseCommitted) {
          return;
        }
        active.actionState = 'localWindowElapsed';
        this.transition('pending', this.toViewModel(active));
      }, LOCAL_APPROVAL_WINDOW_MS),
    };
    this.active = active;
    this.transition('pending', this.toViewModel(active));
  };

  handleNotification = (
    message: Extract<ServerMessage, { kind: 'notification' }>,
  ): void => {
    const completion = parseCommandApprovalCompletion(message);
    if (!completion && isCommandApprovalCompletionCandidate(message)) {
      this.options.onProtocolFailure();
      return;
    }
    if (
      !completion ||
      !this.active ||
      completion.approvalId !== this.active.params.approvalId ||
      completion.threadId !== this.active.params.threadId ||
      completion.turnId !== this.active.params.turnId
    ) {
      return;
    }
    if (
      completion.workspaceWriteRiskAcknowledgement !==
      this.active.params.workspaceWriteRisk
    ) {
      this.options.onProtocolFailure();
      return;
    }

    const status = this.statusForDecision(completion.decision);
    if (!status) {
      this.options.onProtocolFailure();
      return;
    }
    this.finish(status);
  };

  approve = (
    presentationId: unknown,
    mode: unknown = 'ask',
  ): Promise<CommandApprovalActionResult> =>
    this.respond(presentationId, 'approved', false, mode);

  deny = (
    presentationId: unknown,
  ): Promise<CommandApprovalActionResult> =>
    this.respond(presentationId, 'denied');

  setMode = (
    mode: unknown,
    threadId?: unknown,
  ): CommandApprovalActionResult => {
    if (!isCommandApprovalMode(mode) || this.active) {
      return actionResult(this.active ? 'stale' : 'invalid');
    }
    if (threadId !== undefined && (typeof threadId !== 'string' || !threadId)) {
      return actionResult('invalid');
    }
    this.applyMode(mode, typeof threadId === 'string' ? threadId : null);
    this.transition(this.snapshot.status);
    return actionResult('accepted');
  };

  resetScope = (): void => {
    this.applyMode('ask', null);
    this.transition(this.snapshot.status);
  };

  surfaceUnavailable = (): void => {
    this.surfaceReady = false;
    if (!this.active) {
      return;
    }
    if (this.active.responseCommitted) {
      if (this.active.actionState === 'submittingApproval') {
        this.options.onSurfaceFailure();
      }
      return;
    }
    void this.respond(this.active.presentationId, 'denied', true);
  };

  transportClosed = (): void => {
    if (this.active) {
      this.finish('cancelled');
    }
  };

  shutdown = (): void => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.surfaceUnavailable();
    this.transportClosed();
  };

  private respond = async (
    presentationId: unknown,
    decision: CommandApprovalResponseDecision,
    allowElapsed = false,
    requestedMode: unknown = 'ask',
  ): Promise<CommandApprovalActionResult> => {
    if (typeof presentationId !== 'string' || presentationId.length === 0) {
      return actionResult('invalid');
    }
    if (!isCommandApprovalMode(requestedMode)) {
      return actionResult('invalid');
    }
    const active = this.active;
    if (!active || active.presentationId !== presentationId) {
      return actionResult(this.closed ? 'unavailable' : 'stale');
    }
    if (
      active.responseCommitted ||
      (active.actionState === 'localWindowElapsed' && !allowElapsed)
    ) {
      return actionResult('stale');
    }

    active.responseCommitted = true;
    active.actionState =
      decision === 'approved'
        ? 'submittingApproval'
        : 'submittingDenial';
    clearTimeout(active.timer);
    this.transition('pending', this.toViewModel(active));
    try {
      await this.options.writeDecision(active.requestId, decision);
      if (decision === 'approved') {
        this.applyMode(requestedMode, active.params.threadId);
      }
      return actionResult('accepted');
    } catch {
      this.options.onWriteFailure();
      return actionResult('unavailable');
    }
  };

  private writeDecision = async (
    requestId: RequestId,
    decision: CommandApprovalResponseDecision,
  ): Promise<void> => {
    try {
      await this.options.writeDecision(requestId, decision);
    } catch {
      this.options.onWriteFailure();
    }
  };

  private approveAutomatically = async (requestId: RequestId): Promise<void> => {
    try {
      await this.options.writeDecision(requestId, 'approved');
    } catch {
      this.options.onWriteFailure();
    }
  };

  private shouldApproveAutomatically = (threadId: string): boolean => {
    const evaluation = evaluateAutomaticCommandApproval(
      this.modeScope,
      threadId,
      this.options.getWorkspaceScope?.(threadId) ?? null,
    );
    if (evaluation.scope !== this.modeScope) {
      this.modeScope = evaluation.scope;
      this.transition(this.snapshot.status);
    }
    return evaluation.approveAutomatically;
  };

  private applyMode = (
    mode: CommandApprovalMode,
    threadId: string | null,
  ): void => {
    this.modeScope = createCommandApprovalModeScope(
      mode,
      threadId,
      threadId ? (this.options.getWorkspaceScope?.(threadId) ?? null) : null,
    );
  };

  private denyThenFail = async (
    requestId: RequestId,
    fail: () => void,
  ): Promise<void> => {
    try {
      await this.options.writeDecision(requestId, 'denied');
      fail();
    } catch {
      this.options.onWriteFailure();
    }
  };

  private toViewModel = (
    active: ActiveApproval,
  ): CommandApprovalViewModel => {
    const source = this.options.describeSource?.(active.params.threadId) ?? {
      projectTitle: 'SugarCode',
      conversationTitle: active.params.threadId,
    };
    return {
      presentationId: active.presentationId,
      description: active.params.description,
      threadId: active.params.threadId,
      turnId: active.params.turnId,
      queueCount: this.options.getQueueCount?.() ?? 1,
      ...source,
      ...(active.params.sourceAgent
        ? { sourceAgent: { ...active.params.sourceAgent } }
        : {}),
      localExpiresAtMs: active.localExpiresAtMs,
      actionState: active.actionState,
    };
  };

  private statusForDecision = (
    decision: string,
  ): Exclude<CommandApprovalStatus, 'idle' | 'pending'> | null => {
    switch (decision) {
      case 'approved':
        return 'approved';
      case 'denied':
      case 'unsupported':
        return 'denied';
      case 'timedOut':
        return 'expired';
      case 'cancelled':
      case 'clientDisconnected':
        return 'cancelled';
      default:
        return null;
    }
  };

  private finish = (
    status: Exclude<CommandApprovalStatus, 'idle' | 'pending'>,
  ): void => {
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active = null;
    }
    this.transition(status);
  };

  private transition = (
    status: CommandApprovalStatus,
    request?: CommandApprovalViewModel,
  ): void => {
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      status,
      mode: this.modeScope.mode,
      ...(this.modeScope.threadId
        ? { modeThreadId: this.modeScope.threadId }
        : {}),
      ...(request ? { request } : {}),
    };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  };
}

const isCommandApprovalMode = (
  value: unknown,
): value is CommandApprovalMode =>
  value === 'ask' || value === 'thread' || value === 'workspace';
