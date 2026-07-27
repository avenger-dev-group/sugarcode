import type { RequestId } from '@sugarcode/app-server-protocol';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { CommandApprovalController } from '../command-approval-controller';
import type { ServerMessage } from '../runtime-validation';

const request = (
  approvalId = 'approval/one',
  workspaceWrite = false,
): Extract<ServerMessage, { kind: 'request' }> => ({
  kind: 'request',
  id: approvalId,
  method: 'item/commandExecution/requestApproval',
  params: {
    approvalId,
    threadId: 'thr_0000000000000001',
    turnId: 'turn_0000000000000001',
    callId: 'call_1',
    command: '/bin/printf',
    arguments: ['%s', 'hello'],
    cwd: '.',
    approvalScope: 'command',
    environmentPolicy: 'minimalV1',
    sandboxed: true,
    sandboxPolicy: 'filesystemReadOnlyV1',
    ...(workspaceWrite
      ? {
          workspaceWritePolicy: 'commandWorkspaceWriteV1',
          workspaceWriteRisk: 'nonTransactionalWorkspaceTreeV1',
        }
      : {}),
    networkPolicy: 'networkDeniedV1',
  },
});

const completion = (
  approvalId: string,
  decision: string,
): Extract<ServerMessage, { kind: 'notification' }> => ({
  kind: 'notification',
  method: 'item/completed',
  params: {
    threadId: 'thr_0000000000000001',
    turnId: 'turn_0000000000000001',
    item: {
      type: 'commandApprovalDecision',
      id: 'item_decision_1',
      approvalId,
      decision,
    },
  },
});

const createController = (
  platform: NodeJS.Platform = 'darwin',
) => {
  const writes: Array<{
    id: RequestId;
    decision: 'approved' | 'denied';
  }> = [];
  const writeDecision = vi.fn(async (id, decision) => {
    writes.push({ id, decision });
  });
  const onProtocolFailure = vi.fn();
  const onWriteFailure = vi.fn();
  const onSurfaceFailure = vi.fn();
  const controller = new CommandApprovalController({
    platform,
    now: () => 1_000,
    createPresentationId: () => 'presentation/one',
    writeDecision,
    onProtocolFailure,
    onWriteFailure,
    onSurfaceFailure,
  });
  return {
    controller,
    onProtocolFailure,
    onSurfaceFailure,
    onWriteFailure,
    writeDecision,
    writes,
  };
};

describe('CommandApprovalController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('denies requests until the trusted Renderer marks the surface ready', async () => {
    const { controller, writeDecision } = createController();

    controller.handleServerRequest(request());
    await vi.waitFor(() =>
      expect(writeDecision).toHaveBeenCalledWith(
        'approval/one',
        'denied',
      ),
    );
    expect(controller.getSnapshot()).toEqual({
      revision: 0,
      status: 'idle',
    });
  });

  it('denies a valid workspace-write request without presenting or failing the protocol', async () => {
    const { controller, onProtocolFailure, writeDecision } =
      createController('linux');
    controller.markSurfaceReady();

    controller.handleServerRequest(request('approval/write', true));

    await vi.waitFor(() =>
      expect(writeDecision).toHaveBeenCalledWith(
        'approval/write',
        'denied',
      ),
    );
    expect(onProtocolFailure).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual({
      revision: 0,
      status: 'idle',
    });
  });

  it('fails closed when workspace-write policy omits its risk contract', async () => {
    const { controller, onProtocolFailure, writeDecision } =
      createController('linux');
    controller.markSurfaceReady();
    const invalid = request('approval/write-invalid', true);
    delete (
      invalid.params as Record<string, unknown>
    ).workspaceWriteRisk;

    controller.handleServerRequest(invalid);

    await vi.waitFor(() =>
      expect(writeDecision).toHaveBeenCalledWith(
        'approval/write-invalid',
        'denied',
      ),
    );
    expect(onProtocolFailure).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toEqual({
      revision: 0,
      status: 'idle',
    });
  });

  it('correlates one explicit action and waits for durable completion', async () => {
    const { controller, writeDecision } = createController();
    controller.markSurfaceReady();
    controller.handleServerRequest(request());

    expect(controller.getSnapshot()).toMatchObject({
      status: 'pending',
      request: {
        presentationId: 'presentation/one',
        command: '/bin/printf',
        arguments: ['%s', 'hello'],
        localExpiresAtMs: 121_000,
        actionState: 'awaitingUser',
      },
    });
    expect(controller.getSnapshot().request).not.toHaveProperty(
      'approvalId',
    );
    await expect(
      controller.approve('presentation/one'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    expect(writeDecision).toHaveBeenCalledWith(
      'approval/one',
      'approved',
    );
    expect(controller.getSnapshot()).toMatchObject({
      status: 'pending',
      request: { actionState: 'submittingApproval' },
    });
    await expect(
      controller.deny('presentation/one'),
    ).resolves.toEqual({ accepted: false, reason: 'stale' });

    controller.handleNotification(
      completion('approval/other', 'approved'),
    );
    expect(controller.getSnapshot().status).toBe('pending');
    controller.handleNotification({
      kind: 'notification',
      method: 'item/completed',
      params: {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'commandExecutionAttempt',
          id: 'item_attempt_1',
          approvalId: 'approval/one',
          callId: 'call_1',
        },
      },
    });
    expect(controller.getSnapshot().status).toBe('pending');
    controller.handleNotification(
      completion('approval/one', 'approved'),
    );
    expect(controller.getSnapshot()).toEqual({
      revision: 3,
      status: 'approved',
    });
  });

  it('denies overlapping requests while retaining the active request', async () => {
    const { controller, writeDecision } = createController();
    controller.markSurfaceReady();
    controller.handleServerRequest(request('approval/one'));
    controller.handleServerRequest(request('approval/two'));

    await vi.waitFor(() =>
      expect(writeDecision).toHaveBeenCalledWith(
        'approval/two',
        'denied',
      ),
    );
    expect(controller.getSnapshot()).toMatchObject({
      status: 'pending',
      request: { presentationId: 'presentation/one' },
    });
  });

  it('disables local action at 120 seconds without extending or answering the server', async () => {
    const { controller, writeDecision } = createController();
    controller.markSurfaceReady();
    controller.handleServerRequest(request());

    await vi.advanceTimersByTimeAsync(120_000);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'pending',
      request: { actionState: 'localWindowElapsed' },
    });
    expect(writeDecision).not.toHaveBeenCalled();
    await expect(
      controller.approve('presentation/one'),
    ).resolves.toEqual({ accepted: false, reason: 'stale' });

    controller.handleNotification(
      completion('approval/one', 'timedOut'),
    );
    expect(controller.getSnapshot().status).toBe('expired');
  });

  it('fails closed on surface loss, transport close, and write failure', async () => {
    const first = createController();
    first.controller.markSurfaceReady();
    first.controller.handleServerRequest(request());
    first.controller.surfaceUnavailable();
    first.controller.surfaceUnavailable();
    await vi.waitFor(() =>
      expect(first.writeDecision).toHaveBeenCalledWith(
        'approval/one',
        'denied',
      ),
    );
    expect(first.onSurfaceFailure).not.toHaveBeenCalled();

    first.controller.transportClosed();
    expect(first.controller.getSnapshot().status).toBe('cancelled');

    const second = createController();
    second.writeDecision.mockRejectedValueOnce(new Error('closed'));
    second.controller.markSurfaceReady();
    second.controller.handleServerRequest(request());
    await expect(
      second.controller.approve('presentation/one'),
    ).resolves.toEqual({ accepted: false, reason: 'unavailable' });
    expect(second.onWriteFailure).toHaveBeenCalledOnce();

    const approved = createController();
    approved.controller.markSurfaceReady();
    approved.controller.handleServerRequest(request());
    await approved.controller.approve('presentation/one');
    approved.controller.surfaceUnavailable();
    expect(approved.onSurfaceFailure).toHaveBeenCalledOnce();
  });

  it('denies and terminates invalid, Windows, and unknown durable decisions', async () => {
    const invalid = createController();
    invalid.controller.markSurfaceReady();
    invalid.controller.handleServerRequest({
      ...request(),
      id: 'approval/wrong',
    });
    await vi.waitFor(() =>
      expect(invalid.onProtocolFailure).toHaveBeenCalledOnce(),
    );
    expect(invalid.writeDecision).toHaveBeenCalledWith(
      'approval/wrong',
      'denied',
    );

    const windows = createController('win32');
    windows.controller.markSurfaceReady();
    windows.controller.handleServerRequest({
      ...request(),
      params: {
        ...(request().params as Record<string, unknown>),
        command: 'C:\\Windows\\System32\\cmd.exe',
      },
    });
    await vi.waitFor(() =>
      expect(windows.onProtocolFailure).toHaveBeenCalledOnce(),
    );
    expect(windows.controller.getSnapshot().status).toBe('idle');

    const unknown = createController();
    unknown.controller.markSurfaceReady();
    unknown.controller.handleServerRequest(request());
    unknown.controller.handleNotification(
      completion('approval/one', 'futureDecision'),
    );
    expect(unknown.onProtocolFailure).toHaveBeenCalledOnce();
    expect(unknown.controller.getSnapshot().status).toBe('pending');
  });
});
