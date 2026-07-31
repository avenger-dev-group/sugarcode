import type {
  McpToolCallApprovalResponseDecision,
  RequestId,
} from '@sugarcode/app-server-protocol';
import { randomUUID } from 'node:crypto';

import type {
  McpApprovalActionResult,
  McpApprovalStateSnapshot,
  McpApprovalStatus,
  McpApprovalViewModel,
} from '@/shared/mcp';

import {
  isMcpApprovalCompletionCandidate,
  parseMcpApprovalCompletion,
  parseMcpApprovalRequest,
  type ParsedMcpApproval,
} from './protocol';
import type { ServerMessage } from '../transport/server-message';

const LOCAL_APPROVAL_WINDOW_MS = 120_000;

type McpApprovalControllerOptions = Readonly<{
  getActiveServerIds: () => readonly string[];
  now?: () => number;
  createPresentationId?: () => string;
  writeDecision: (
    requestId: RequestId,
    decision: McpToolCallApprovalResponseDecision,
  ) => Promise<void>;
  onProtocolFailure: () => void;
  onWriteFailure: () => void;
  onSurfaceFailure: () => void;
}>;

type ActiveApproval = {
  requestId: RequestId;
  parsed: ParsedMcpApproval;
  presentationId: string;
  localExpiresAtMs: number;
  actionState: McpApprovalViewModel['actionState'];
  responseCommitted: boolean;
  timer: ReturnType<typeof setTimeout>;
};

const actionResult = (
  reason: McpApprovalActionResult['reason'],
): McpApprovalActionResult => ({
  accepted: reason === 'accepted',
  reason,
});

export class McpApprovalController {
  private readonly options: Required<
    Pick<McpApprovalControllerOptions, 'now' | 'createPresentationId'>
  > &
    Omit<McpApprovalControllerOptions, 'now' | 'createPresentationId'>;
  private readonly listeners = new Set<
    (snapshot: McpApprovalStateSnapshot) => void
  >();
  private snapshot: McpApprovalStateSnapshot = {
    revision: 0,
    status: 'idle',
  };
  private active: ActiveApproval | null = null;
  private surfaceReady = false;
  private closed = false;

  constructor(options: McpApprovalControllerOptions) {
    this.options = {
      ...options,
      now: options.now ?? Date.now,
      createPresentationId: options.createPresentationId ?? randomUUID,
    };
  }

  getSnapshot = (): McpApprovalStateSnapshot => this.snapshot;

  subscribe = (
    listener: (snapshot: McpApprovalStateSnapshot) => void,
  ): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  markSurfaceReady = (): McpApprovalStateSnapshot => {
    this.surfaceReady = true;
    return this.snapshot;
  };

  isSurfaceReady = (): boolean => this.surfaceReady;

  handleServerRequest = (
    request: Extract<ServerMessage, { kind: 'request' }>,
  ): void => {
    if (
      request.method !== 'item/mcpToolCall/requestApproval' ||
      this.closed
    ) {
      this.options.onProtocolFailure();
      return;
    }
    const parsed = parseMcpApprovalRequest(
      request.id,
      request.params,
      this.options.getActiveServerIds(),
    );
    if (!parsed) {
      void this.denyThenFail(request.id);
      return;
    }
    if (!this.surfaceReady || this.active) {
      void this.writeDecision(request.id, 'denied');
      return;
    }
    const active: ActiveApproval = {
      requestId: request.id,
      parsed,
      presentationId: this.options.createPresentationId(),
      localExpiresAtMs: this.options.now() + LOCAL_APPROVAL_WINDOW_MS,
      actionState: 'awaitingUser',
      responseCommitted: false,
      timer: setTimeout(() => {
        if (this.active !== active || active.responseCommitted) {
          return;
        }
        active.actionState = 'localWindowElapsed';
        this.transition('pending', this.toViewModel(active));
        void this.respond(active.presentationId, 'denied', true);
      }, LOCAL_APPROVAL_WINDOW_MS),
    };
    this.active = active;
    this.transition('pending', this.toViewModel(active));
  };

  handleNotification = (
    message: Extract<ServerMessage, { kind: 'notification' }>,
  ): void => {
    const completion = parseMcpApprovalCompletion(message);
    if (!completion && isMcpApprovalCompletionCandidate(message)) {
      this.options.onProtocolFailure();
      return;
    }
    if (
      !completion ||
      !this.active ||
      completion.approvalId !== this.active.parsed.params.approvalId ||
      completion.threadId !== this.active.parsed.params.threadId ||
      completion.turnId !== this.active.parsed.params.turnId
    ) {
      return;
    }
    const status = this.statusForDecision(completion.decision);
    if (!status) {
      this.options.onProtocolFailure();
      return;
    }
    this.finish(status);
  };

  approve = (presentationId: unknown): Promise<McpApprovalActionResult> =>
    this.respond(presentationId, 'approved');

  deny = (presentationId: unknown): Promise<McpApprovalActionResult> =>
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
    decision: McpToolCallApprovalResponseDecision,
    allowElapsed = false,
  ): Promise<McpApprovalActionResult> => {
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
    decision: McpToolCallApprovalResponseDecision,
  ): Promise<void> => {
    try {
      await this.options.writeDecision(requestId, decision);
    } catch {
      this.options.onWriteFailure();
    }
  };

  private denyThenFail = async (requestId: RequestId): Promise<void> => {
    try {
      await this.options.writeDecision(requestId, 'denied');
      this.options.onProtocolFailure();
    } catch {
      this.options.onWriteFailure();
    }
  };

  private toViewModel = (
    active: ActiveApproval,
  ): McpApprovalViewModel => ({
    presentationId: active.presentationId,
    serverId: active.parsed.serverId,
    name: active.parsed.params.name,
    argumentsJson: active.parsed.argumentsJson,
    argumentsBytes: active.parsed.argumentsBytes,
    argumentsSha256: active.parsed.params.argumentsSha256,
    inventorySha256: active.parsed.params.inventorySha256,
    ...(active.parsed.params.sourceAgent
      ? { sourceAgent: { ...active.parsed.params.sourceAgent } }
      : {}),
    localExpiresAtMs: active.localExpiresAtMs,
    actionState: active.actionState,
  });

  private statusForDecision = (
    decision: string,
  ): Exclude<McpApprovalStatus, 'idle' | 'pending'> | null => {
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
    status: Exclude<McpApprovalStatus, 'idle' | 'pending'>,
  ): void => {
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active = null;
    }
    this.transition(status);
  };

  private transition = (
    status: McpApprovalStatus,
    request?: McpApprovalViewModel,
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
