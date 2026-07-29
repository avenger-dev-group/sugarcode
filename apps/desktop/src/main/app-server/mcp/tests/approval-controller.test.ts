import { describe, expect, it, vi } from 'vitest';

import { McpApprovalController } from '../approval-controller';

const approvalRequest = {
  kind: 'request',
  id: 'approval/1',
  method: 'item/mcpToolCall/requestApproval',
  params: {
    approvalId: 'approval/1',
    threadId: 'thread/1',
    turnId: 'turn/1',
    callId: 'call/1',
    name: 'mcp__alpha__lookup',
    arguments: { query: 'sugar' },
    argumentsBytes: 17,
    argumentsSha256: 'a'.repeat(64),
    inventorySha256: 'b'.repeat(64),
  },
} as const;

describe('McpApprovalController', () => {
  it('denies without a ready surface and records one correlated decision', async () => {
    const writeDecision = vi.fn(() => Promise.resolve());
    const controller = new McpApprovalController({
      getActiveServerIds: () => ['alpha'],
      createPresentationId: () => 'presentation/1',
      writeDecision,
      onProtocolFailure: vi.fn(),
      onWriteFailure: vi.fn(),
      onSurfaceFailure: vi.fn(),
    });
    controller.handleServerRequest(approvalRequest);
    await vi.waitFor(() =>
      expect(writeDecision).toHaveBeenCalledWith('approval/1', 'denied'),
    );
    expect(controller.getSnapshot().status).toBe('idle');

    controller.markSurfaceReady();
    controller.handleServerRequest(approvalRequest);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'pending',
      request: {
        presentationId: 'presentation/1',
        serverId: 'alpha',
        name: 'mcp__alpha__lookup',
        argumentsJson: '{"query":"sugar"}',
      },
    });
    await expect(controller.approve('presentation/1')).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    controller.handleNotification({
      kind: 'notification',
      method: 'item/completed',
      params: {
        threadId: 'thread/1',
        turnId: 'turn/1',
        item: {
          type: 'mcpToolCallApprovalDecision',
          id: 'item/decision',
          approvalId: 'approval/1',
          decision: 'approved',
        },
      },
    });
    expect(controller.getSnapshot().status).toBe('approved');
    controller.shutdown();
  });

  it('defaults an unanswered request to one denial when the local window elapses', async () => {
    vi.useFakeTimers();
    const writeDecision = vi.fn(() => Promise.resolve());
    const controller = new McpApprovalController({
      getActiveServerIds: () => ['alpha'],
      createPresentationId: () => 'presentation/timeout',
      writeDecision,
      onProtocolFailure: vi.fn(),
      onWriteFailure: vi.fn(),
      onSurfaceFailure: vi.fn(),
    });
    controller.markSurfaceReady();
    controller.handleServerRequest(approvalRequest);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(writeDecision).toHaveBeenCalledTimes(1);
    expect(writeDecision).toHaveBeenCalledWith('approval/1', 'denied');
    expect(controller.getSnapshot()).toMatchObject({
      status: 'pending',
      request: { actionState: 'submittingDenial' },
    });
    await expect(controller.approve('presentation/timeout')).resolves.toEqual({
      accepted: false,
      reason: 'stale',
    });
    controller.shutdown();
    vi.useRealTimers();
  });
});
