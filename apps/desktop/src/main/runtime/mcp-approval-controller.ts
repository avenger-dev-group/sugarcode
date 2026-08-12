import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  McpApprovalActionResult,
  McpApprovalStateSnapshot,
  McpApprovalViewModel,
} from '../../shared/mcp.ts';
import type { RuntimeEvent } from '../../runtime/protocol.ts';
import type { RuntimeSupervisor } from './supervisor.ts';

const LOCAL_APPROVAL_WINDOW_MS = 120_000;

type PendingApproval = Extract<
  RuntimeEvent,
  { type: 'mcp.approvalRequested' }
> & {
  timer: NodeJS.Timeout | null;
  actionState: McpApprovalViewModel['actionState'];
};
// The UI deadline is captured once so rerenders cannot extend an approval.
type PendingRuntimeApproval = PendingApproval & {
  localExpiresAtMs: number;
  responseCommitted: boolean;
  committedDecision?: 'approved' | 'denied';
  committedSource?: 'user' | 'policy' | 'system';
};

const action = (
  reason: McpApprovalActionResult['reason'],
): McpApprovalActionResult => ({ accepted: reason === 'accepted', reason });

export class RuntimeMcpApprovalController {
  private readonly listeners = new Set<
    (snapshot: McpApprovalStateSnapshot) => void
  >();
  private readonly queue: PendingRuntimeApproval[] = [];
  private readonly workspaceRoots = new Map<string, string>();
  private revision = 0;
  private surfaceReady = false;
  private readonly runtime: RuntimeSupervisor;
  private readonly shouldAutoApprove: (
    workspaceId: string,
    threadId: string,
  ) => boolean;
  private readonly approvalWindowMs: number;

  constructor(
    runtime: RuntimeSupervisor,
    shouldAutoApprove: (workspaceId: string, threadId: string) => boolean =
      () => false,
    approvalWindowMs = LOCAL_APPROVAL_WINDOW_MS,
  ) {
    this.runtime = runtime;
    this.shouldAutoApprove = shouldAutoApprove;
    this.approvalWindowMs = approvalWindowMs;
    runtime.subscribe(this.handleRuntimeEvent);
  }

  openWorkspace = (workspaceId: string, canonicalRoot: string): void => {
    this.workspaceRoots.set(workspaceId, canonicalRoot);
    if (this.queue.some((pending) => pending.workspaceId === workspaceId)) {
      this.publish();
    }
  };

  getSnapshot = (): McpApprovalStateSnapshot => {
    const pending = this.queue[0];
    const requests = this.queue.map((item) => this.viewModel(item));
    return {
      revision: this.revision,
      status: pending ? 'pending' : 'idle',
      requests,
      ...(pending ? { request: requests[0] } : {}),
    };
  };

  subscribe = (
    listener: (snapshot: McpApprovalStateSnapshot) => void,
  ): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  markSurfaceReady = (): McpApprovalStateSnapshot => {
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
      }
      this.resolve(pending, 'denied', 'system');
    }
  };

  approve = async (presentationId: unknown): Promise<McpApprovalActionResult> =>
    this.respond(presentationId, 'approved');

  deny = async (presentationId: unknown): Promise<McpApprovalActionResult> =>
    this.respond(presentationId, 'denied');

  refreshPolicy = (): void => {
    let changed = false;
    for (const pending of this.queue) {
      if (
        pending.responseCommitted ||
        !this.shouldAutoApprove(pending.workspaceId, pending.threadId)
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
      changed = true;
    }
    if (changed) {
      this.publish();
    }
  };

  private respond = (
    presentationId: unknown,
    decision: 'approved' | 'denied',
  ): McpApprovalActionResult => {
    if (typeof presentationId !== 'string' || presentationId.length === 0) {
      return action('invalid');
    }
    const pending = this.queue.find(
      (item) => item.approvalId === presentationId,
    );
    if (!pending) {
      return action(this.queue.length === 0 ? 'unavailable' : 'stale');
    }
    if (pending.responseCommitted) {
      return action('stale');
    }
    pending.responseCommitted = true;
    pending.actionState = decision === 'approved'
      ? 'submittingApproval'
      : 'submittingDenial';
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.publish();
    this.resolve(pending, decision, 'user');
    return action('accepted');
  };

  private resolve = (
    pending: PendingRuntimeApproval,
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

  private handleRuntimeEvent = (event: RuntimeEvent): void => {
    if (event.type === 'mcp.approvalRequested') {
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
      const pending: PendingRuntimeApproval = {
        ...event,
        actionState: 'awaitingUser',
        localExpiresAtMs: Date.now() + LOCAL_APPROVAL_WINDOW_MS,
        responseCommitted: false,
        timer: null,
      };
      this.queue.push(pending);
      if (this.shouldAutoApprove(pending.workspaceId, pending.threadId)) {
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
    if (event.type === 'mcp.approvalResolved') {
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

  private startTimer = (pending: PendingRuntimeApproval): void => {
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
      this.resolve(pending, 'approved', 'system');
    }, this.approvalWindowMs);
    pending.timer.unref();
  };

  private viewModel = (pending: PendingRuntimeApproval): McpApprovalViewModel => {
    const root = this.workspaceRoots.get(pending.workspaceId) ?? 'Local workspace';
    return {
      presentationId: pending.approvalId,
      threadId: pending.threadId,
      turnId: pending.turnId,
      queueCount: this.queue.length,
      projectTitle: path.basename(root) || 'Workspace',
      conversationTitle: pending.threadId,
      serverId: pending.serverId,
      name: pending.name,
      argumentsJson: pending.argumentsJson,
      argumentsBytes: pending.argumentsBytes,
      argumentsSha256: pending.argumentsSha256,
      inventorySha256: pending.inventorySha256,
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
