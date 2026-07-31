import type {
  CommandApprovalParams,
  CommandApprovalResponseDecision,
  RequestId,
} from '@sugarcode/app-server-protocol';
import { randomUUID } from 'node:crypto';

import type {
  CommandApprovalActionResult,
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
  };
  private active: ActiveApproval | null = null;
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

  subscribe = (listener: CommandApprovalStateListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  markSurfaceReady = (): CommandApprovalStateSnapshot => {
    this.surfaceReady = true;
    return this.snapshot;
  };

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
  ): Promise<CommandApprovalActionResult> =>
    this.respond(presentationId, 'approved');

  deny = (
    presentationId: unknown,
  ): Promise<CommandApprovalActionResult> =>
    this.respond(presentationId, 'denied');

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
  ): Promise<CommandApprovalActionResult> => {
    if (typeof presentationId !== 'string' || presentationId.length === 0) {
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
  ): CommandApprovalViewModel => ({
    presentationId: active.presentationId,
    command: active.params.command,
    arguments: [...active.params.arguments],
    cwd: active.params.cwd,
    approvalScope: 'command',
    environmentPolicy: 'minimalV1',
    sandboxed: true,
    sandboxPolicy: 'filesystemReadOnlyV1',
    networkPolicy: 'networkDeniedV1',
    ...(active.params.sourceAgent
      ? { sourceAgent: { ...active.params.sourceAgent } }
      : {}),
    localExpiresAtMs: active.localExpiresAtMs,
    actionState: active.actionState,
  });

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
      ...(request ? { request } : {}),
    };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  };
}
