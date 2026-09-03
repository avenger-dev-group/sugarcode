import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  CommandApprovalActionResult,
  CommandApprovalMode,
  CommandApprovalStateListener,
  CommandApprovalStateSnapshot,
  CommandApprovalViewModel,
} from '../../../shared/command-approval.ts';
import type { RuntimeEvent } from '../../../runtime/contracts/protocol.ts';
import type { RuntimeSupervisor } from '../connection/supervisor.ts';

const LOCAL_APPROVAL_WINDOW_MS = 5 * 60_000;

type PendingApproval = {
  readonly approvalId: string;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly purpose: string;
  readonly argumentsSummary: string;
  readonly fullAccess: boolean;
  readonly projectEnvironmentTrust: boolean;
  timer: NodeJS.Timeout | null;
  localExpiresAtMs: number;
  actionState: CommandApprovalViewModel['actionState'];
  responseCommitted: boolean;
  committedDecision?: 'approved' | 'denied';
  committedSource?: 'user' | 'policy' | 'system';
};

const result = (
  accepted: boolean,
  reason: CommandApprovalActionResult['reason'],
): CommandApprovalActionResult => ({ accepted, reason });

export class RuntimeApprovalController {
  private readonly runtime: RuntimeSupervisor;
  private readonly listeners = new Set<CommandApprovalStateListener>();
  private readonly queue: PendingApproval[] = [];
  private readonly workspaceRoots = new Map<string, string>();
  private readonly threadWorkspaces = new Map<string, string>();
  private readonly threadModeIds = new Set<string>();
  private readonly workspaceModeIds = new Set<string>();
  private revision = 0;
  private mode: CommandApprovalMode = 'ask';
  private modeThreadId: string | undefined;
  private modeWorkspaceId: string | undefined;
  private surfaceReady = false;
  private readonly approvalWindowMs: number;

  constructor(
    runtime: RuntimeSupervisor,
    approvalWindowMs = LOCAL_APPROVAL_WINDOW_MS,
  ) {
    this.runtime = runtime;
    this.approvalWindowMs = approvalWindowMs;
    runtime.subscribe(this.handleRuntimeEvent);
  }

  openWorkspace = (workspaceId: string, canonicalRoot: string): void => {
    this.workspaceRoots.set(workspaceId, canonicalRoot);
    if (this.queue.some((pending) => pending.workspaceId === workspaceId)) {
      this.publish();
    }
  };

  getSnapshot = (): CommandApprovalStateSnapshot => {
    const pending = this.queue[0];
    const requests = this.queue.map((item) => this.viewModel(item));
    return {
      revision: this.revision,
      status: pending ? 'pending' : 'idle',
      mode: this.mode,
      requests,
      threadModeIds: [...this.threadModeIds],
      workspaceModeIds: [...this.workspaceModeIds],
      ...(this.mode === 'thread' && this.modeThreadId
        ? { modeThreadId: this.modeThreadId }
        : {}),
      ...(this.mode === 'workspace' && this.modeWorkspaceId
        ? { modeWorkspaceId: this.modeWorkspaceId }
        : {}),
      ...(pending ? { request: requests[0] } : {}),
    };
  };

  markSurfaceReady = (): CommandApprovalStateSnapshot => {
    this.surfaceReady = true;
    for (const pending of this.queue) {
      this.startTimer(pending);
    }
    return this.getSnapshot();
  };

  surfaceUnavailable = (): void => {
    this.surfaceReady = false;
    for (const pending of [...this.queue]) {
      if (pending.responseCommitted) {
        continue;
      }
      pending.responseCommitted = true;
      pending.actionState = 'submittingDenial';
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
      this.resolve(pending, 'denied', 'system');
    }
  };

  subscribe = (listener: CommandApprovalStateListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  approve = async (
    presentationId: unknown,
    mode: unknown,
  ): Promise<CommandApprovalActionResult> => {
    const pending = this.queue.find(
      (item) => item.approvalId === presentationId,
    );
    if (!pending) {
      return result(false, this.queue.length === 0 ? 'unavailable' : 'stale');
    }
    if (presentationId !== pending.approvalId) {
      return result(false, 'stale');
    }
    if (pending.responseCommitted) {
      return result(false, 'stale');
    }
    if (!['ask', 'thread', 'workspace'].includes(String(mode))) {
      return result(false, 'invalid');
    }
    if (pending.projectEnvironmentTrust) {
      if (mode !== 'ask') {
        return result(false, 'invalid');
      }
      const response = this.respond(pending, 'approved', false);
      this.publish();
      return response;
    }
    if (
      !this.assignMode(
        mode as CommandApprovalMode,
        pending.threadId,
        pending.workspaceId,
      )
    ) {
      return result(false, 'invalid');
    }
    const response = this.respond(pending, 'approved', false);
    this.approveMatchingPending();
    this.publish();
    return response;
  };

  deny = async (presentationId: unknown): Promise<CommandApprovalActionResult> => {
    const pending = this.queue.find(
      (item) => item.approvalId === presentationId,
    );
    if (!pending) {
      return result(false, this.queue.length === 0 ? 'unavailable' : 'stale');
    }
    if (presentationId !== pending.approvalId) {
      return result(false, 'stale');
    }
    if (pending.responseCommitted) {
      return result(false, 'stale');
    }
    return this.respond(pending, 'denied');
  };

  setMode = (
    mode: unknown,
    threadId?: unknown,
    workspaceId?: unknown,
  ): CommandApprovalActionResult => {
    if (!['ask', 'thread', 'workspace'].includes(String(mode))) {
      return result(false, 'invalid');
    }
    if (
      !this.assignMode(
        mode as CommandApprovalMode,
        threadId,
        workspaceId,
      )
    ) {
      return result(false, 'invalid');
    }
    this.approveMatchingPending();
    this.publish();
    return result(true, 'accepted');
  };

  private handleRuntimeEvent = (event: RuntimeEvent): void => {
    if (event.type === 'approval.requested') {
      const existing = this.queue.find(
        (pending) => pending.approvalId === event.approvalId,
      );
      if (existing) {
        if (
          event.recovered === true &&
          existing.responseCommitted &&
          existing.committedDecision &&
          existing.committedSource
        ) {
          this.resolve(
            existing,
            existing.committedDecision,
            existing.committedSource,
          );
        }
        return;
      }
      const pending: PendingApproval = {
        approvalId: event.approvalId,
        operationId: event.operationId,
        workspaceId: event.workspaceId,
        threadId: event.threadId,
        turnId: event.turnId,
        toolName: event.toolName,
        purpose: event.purpose,
        argumentsSummary: event.argumentsSummary,
        fullAccess: event.fullAccess,
        projectEnvironmentTrust: event.projectEnvironmentTrust === true,
        timer: null,
        localExpiresAtMs: 0,
        actionState: 'awaitingUser',
        responseCommitted: false,
      };
      this.threadWorkspaces.set(event.threadId, event.workspaceId);
      this.queue.push(pending);
      if (
        !pending.projectEnvironmentTrust &&
        this.isAutoApproved(pending.workspaceId, pending.threadId)
      ) {
        pending.responseCommitted = true;
        pending.actionState = 'submittingApproval';
        this.resolve(pending, 'approved', 'policy');
      } else if (!this.surfaceReady && event.recovered !== true) {
        pending.responseCommitted = true;
        pending.actionState = 'submittingDenial';
        this.resolve(pending, 'denied', 'system');
      } else {
        this.startTimer(pending);
        this.publish();
      }
      return;
    }
    if (event.type === 'approval.resolved') {
      const index = this.queue.findIndex(
        (pending) => pending.approvalId === event.approvalId,
      );
      if (index >= 0) {
        const timer = this.queue[index].timer;
        if (timer) {
          clearTimeout(timer);
        }
        this.queue.splice(index, 1);
        this.publish();
      }
    }
  };

  private respond = (
    pending: PendingApproval,
    decision: 'approved' | 'denied',
    publish = true,
  ): CommandApprovalActionResult => {
    pending.responseCommitted = true;
    pending.actionState = decision === 'approved'
      ? 'submittingApproval'
      : 'submittingDenial';
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (publish) {
      this.publish();
    }
    this.resolve(pending, decision, 'user');
    return result(true, 'accepted');
  };

  private resolve = (
    pending: PendingApproval,
    decision: 'approved' | 'denied',
    source: 'user' | 'policy' | 'system',
  ): void => {
    pending.committedDecision = decision;
    pending.committedSource = source;
    try {
      this.runtime.send({
        type: 'approval.resolve',
        requestId: randomUUID(),
        workspaceId: pending.workspaceId,
        threadId: pending.threadId,
        turnId: pending.turnId,
        approvalId: pending.approvalId,
        decision,
        source,
      });
    } catch {
      // App shutdown can close the utility runtime before Electron disposes IPC.
    }
  };

  private startTimer = (pending: PendingApproval): void => {
    if (!this.surfaceReady || pending.timer || pending.responseCommitted) {
      return;
    }
    pending.localExpiresAtMs = Date.now() + this.approvalWindowMs;
    pending.timer = setTimeout(() => {
      if (!this.queue.includes(pending) || pending.responseCommitted) {
        return;
      }
      pending.responseCommitted = true;
      pending.actionState = 'localWindowElapsed';
      pending.timer = null;
      this.publish();
      this.resolve(
        pending,
        pending.projectEnvironmentTrust ? 'denied' : 'approved',
        'system',
      );
    }, this.approvalWindowMs);
    pending.timer.unref();
  };

  private assignMode = (
    mode: CommandApprovalMode,
    threadId?: unknown,
    workspaceId?: unknown,
  ): boolean => {
    if (
      mode === 'thread' &&
      (typeof threadId !== 'string' || threadId.length === 0)
    ) {
      return false;
    }
    if (
      mode === 'workspace' &&
      (typeof workspaceId !== 'string' ||
        workspaceId.length === 0 ||
        !this.workspaceRoots.has(workspaceId))
    ) {
      return false;
    }
    const resolvedThreadId = typeof threadId === 'string' ? threadId : undefined;
    const resolvedWorkspaceId =
      typeof workspaceId === 'string' ? workspaceId : undefined;
    if (mode === 'ask') {
      if (!resolvedThreadId && !resolvedWorkspaceId) {
        this.threadModeIds.clear();
        this.workspaceModeIds.clear();
      } else if (resolvedThreadId) {
        this.threadModeIds.delete(resolvedThreadId);
      }
      if (resolvedWorkspaceId) {
        this.workspaceModeIds.delete(resolvedWorkspaceId);
      }
    } else if (mode === 'thread' && resolvedThreadId) {
      this.threadModeIds.add(resolvedThreadId);
      if (resolvedWorkspaceId) {
        this.workspaceModeIds.delete(resolvedWorkspaceId);
      }
    } else if (mode === 'workspace' && resolvedWorkspaceId) {
      this.workspaceModeIds.add(resolvedWorkspaceId);
      for (const [knownThreadId, knownWorkspaceId] of this.threadWorkspaces) {
        if (knownWorkspaceId === resolvedWorkspaceId) {
          this.threadModeIds.delete(knownThreadId);
        }
      }
    }
    this.mode = mode;
    this.modeThreadId = mode === 'thread' ? threadId as string : undefined;
    this.modeWorkspaceId =
      mode === 'workspace' ? workspaceId as string : undefined;
    return true;
  };

  isAutoApproved = (workspaceId: string, threadId: string): boolean =>
    this.threadModeIds.has(threadId) || this.workspaceModeIds.has(workspaceId);

  private approveMatchingPending = (): void => {
    for (const pending of this.queue) {
      if (
        pending.responseCommitted ||
        pending.projectEnvironmentTrust ||
        !this.isAutoApproved(pending.workspaceId, pending.threadId)
      ) {
        continue;
      }
      pending.responseCommitted = true;
      pending.actionState = 'submittingApproval';
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
      this.resolve(pending, 'approved', 'policy');
    }
  };

  private viewModel = (pending: PendingApproval): CommandApprovalViewModel => {
    const root = this.workspaceRoots.get(pending.workspaceId) ?? 'Local workspace';
    return {
      presentationId: pending.approvalId,
      operationKind:
        pending.projectEnvironmentTrust
          ? 'projectEnvironment'
          : pending.toolName === 'workspace_apply_patch'
            ? 'workspacePatch'
            : 'shell',
      description: pending.purpose,
      command: pending.argumentsSummary,
      cwd: root,
      fullAccess: pending.fullAccess,
      workspaceId: pending.workspaceId,
      threadId: pending.threadId,
      turnId: pending.turnId,
      queueCount: this.queue.length,
      projectTitle: path.basename(root) || 'Workspace',
      conversationTitle: pending.threadId,
      localExpiresAtMs: pending.localExpiresAtMs,
      actionState: pending.actionState,
    };
  };

  private publish = (): void => {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  };
}
