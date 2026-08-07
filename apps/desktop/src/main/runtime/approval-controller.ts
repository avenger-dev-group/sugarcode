import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  CommandApprovalActionResult,
  CommandApprovalMode,
  CommandApprovalStateListener,
  CommandApprovalStateSnapshot,
  CommandApprovalViewModel,
} from '../../shared/command-approval.ts';
import type { RuntimeEvent } from '../../runtime/protocol.ts';
import type { RuntimeSupervisor } from './supervisor.ts';

type PendingApproval = Readonly<{
  approvalId: string;
  operationId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  toolName: string;
  argumentsSummary: string;
  fullAccess: boolean;
}>;

const result = (
  accepted: boolean,
  reason: CommandApprovalActionResult['reason'],
): CommandApprovalActionResult => ({ accepted, reason });

export class RuntimeApprovalController {
  private readonly runtime: RuntimeSupervisor;
  private readonly listeners = new Set<CommandApprovalStateListener>();
  private readonly queue: PendingApproval[] = [];
  private readonly workspaceRoots = new Map<string, string>();
  private revision = 0;
  private mode: CommandApprovalMode = 'ask';
  private modeThreadId: string | undefined;
  private modeWorkspaceId: string | undefined;
  private surfaceReady = false;

  constructor(runtime: RuntimeSupervisor) {
    this.runtime = runtime;
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
    return {
      revision: this.revision,
      status: pending ? 'pending' : 'idle',
      mode: this.mode,
      ...(this.mode === 'thread' && this.modeThreadId
        ? { modeThreadId: this.modeThreadId }
        : {}),
      ...(this.mode === 'workspace' && this.modeWorkspaceId
        ? { modeWorkspaceId: this.modeWorkspaceId }
        : {}),
      ...(pending ? { request: this.viewModel(pending) } : {}),
    };
  };

  markSurfaceReady = (): CommandApprovalStateSnapshot => {
    this.surfaceReady = true;
    return this.getSnapshot();
  };

  surfaceUnavailable = (): void => {
    this.surfaceReady = false;
    for (const pending of [...this.queue]) {
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
    const pending = this.queue[0];
    if (!pending) {
      return result(false, 'unavailable');
    }
    if (presentationId !== pending.approvalId) {
      return result(false, 'stale');
    }
    if (!['ask', 'thread', 'workspace'].includes(String(mode))) {
      return result(false, 'invalid');
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
    this.resolve(pending, 'approved', 'user');
    return result(true, 'accepted');
  };

  deny = async (presentationId: unknown): Promise<CommandApprovalActionResult> => {
    const pending = this.queue[0];
    if (!pending) {
      return result(false, 'unavailable');
    }
    if (presentationId !== pending.approvalId) {
      return result(false, 'stale');
    }
    this.resolve(pending, 'denied', 'user');
    return result(true, 'accepted');
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
    this.publish();
    return result(true, 'accepted');
  };

  private handleRuntimeEvent = (event: RuntimeEvent): void => {
    if (event.type === 'approval.requested') {
      if (this.queue.some((pending) => pending.approvalId === event.approvalId)) {
        return;
      }
      const pending: PendingApproval = {
        approvalId: event.approvalId,
        operationId: event.operationId,
        workspaceId: event.workspaceId,
        threadId: event.threadId,
        turnId: event.turnId,
        toolName: event.toolName,
        argumentsSummary: event.argumentsSummary,
        fullAccess: event.fullAccess,
      };
      this.queue.push(pending);
      if (this.isAutoApproved(pending.workspaceId, pending.threadId)) {
        this.resolve(pending, 'approved', 'policy');
      } else if (!this.surfaceReady && event.recovered !== true) {
        this.resolve(pending, 'denied', 'system');
      } else {
        this.publish();
      }
      return;
    }
    if (event.type === 'approval.resolved') {
      const index = this.queue.findIndex(
        (pending) => pending.approvalId === event.approvalId,
      );
      if (index >= 0) {
        this.queue.splice(index, 1);
        this.publish();
      }
    }
  };

  private resolve = (
    pending: PendingApproval,
    decision: 'approved' | 'denied',
    source: 'user' | 'policy' | 'system',
  ): void => {
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
    this.mode = mode;
    this.modeThreadId = mode === 'thread' ? threadId as string : undefined;
    this.modeWorkspaceId =
      mode === 'workspace' ? workspaceId as string : undefined;
    return true;
  };

  isAutoApproved = (workspaceId: string, threadId: string): boolean =>
    (this.mode === 'thread' && this.modeThreadId === threadId) ||
    (this.mode === 'workspace' &&
      this.modeWorkspaceId === workspaceId);

  private viewModel = (pending: PendingApproval): CommandApprovalViewModel => {
    const root = this.workspaceRoots.get(pending.workspaceId) ?? 'Local workspace';
    return {
      presentationId: pending.approvalId,
      description:
        pending.toolName === 'workspace_apply_patch'
          ? 'Allow the Agent to modify workspace files?'
          : pending.fullAccess
            ? 'Allow this command to run with Full Access?'
          : `Allow ${pending.toolName}?`,
      command: pending.argumentsSummary,
      cwd: root,
      fullAccess: pending.fullAccess,
      workspaceId: pending.workspaceId,
      threadId: pending.threadId,
      turnId: pending.turnId,
      queueCount: this.queue.length,
      projectTitle: path.basename(root) || 'Workspace',
      conversationTitle: pending.threadId,
      localExpiresAtMs: Date.now() + 5 * 60_000,
      actionState: 'awaitingUser',
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
