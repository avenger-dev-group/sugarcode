import type { IpcRendererEvent } from 'electron';

import { describe, expect, it, vi } from 'vitest';

import {
  COMMAND_APPROVAL_APPROVE_CHANNEL,
  COMMAND_APPROVAL_DENY_CHANNEL,
  COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
  COMMAND_APPROVAL_STATE_GET_CHANNEL,
} from '@/shared/command-approval';
import {
  CONNECTION_STATE_CHANGED_CHANNEL,
  CONNECTION_STATE_GET_CHANNEL,
} from '@/shared/connection';

import {
  createDesktopApi,
  type IpcRendererBoundary,
} from '../desktop-api';

const createIpcBoundary = () => {
  const listeners = new Map<
    string,
    (event: IpcRendererEvent, snapshot: unknown) => void
  >();
  const invoke = vi.fn();
  const on = vi.fn(
    (
      channel: string,
      listener: (event: IpcRendererEvent, snapshot: unknown) => void,
    ) => {
      listeners.set(channel, listener);
    },
  );
  const removeListener = vi.fn(
    (
      channel: string,
      listener: (event: IpcRendererEvent, snapshot: unknown) => void,
    ) => {
      if (listeners.get(channel) === listener) {
        listeners.delete(channel);
      }
    },
  );
  const ipc: IpcRendererBoundary = {
    invoke,
    on,
    removeListener,
  };
  return { ipc, invoke, listeners, on, removeListener };
};

describe('createDesktopApi', () => {
  it('uses fixed channels and validates snapshots', async () => {
    const boundary = createIpcBoundary();
    boundary.invoke.mockResolvedValue({ revision: 1, status: 'ready' });
    const api = createDesktopApi(boundary.ipc);

    await expect(api.getConnectionState()).resolves.toEqual({
      revision: 1,
      status: 'ready',
    });
    expect(boundary.invoke).toHaveBeenCalledWith(
      CONNECTION_STATE_GET_CHANNEL,
    );

    boundary.invoke.mockResolvedValue({ revision: -1, status: 'ready' });
    await expect(api.getConnectionState()).rejects.toThrow(
      'invalid connection state',
    );
  });

  it('subscribes, filters invalid payloads, and unsubscribes exactly once', () => {
    const boundary = createIpcBoundary();
    const api = createDesktopApi(boundary.ipc);
    const listener = vi.fn();
    const unsubscribe = api.onConnectionStateChanged(listener);
    const handleStateChanged = boundary.listeners.get(
      CONNECTION_STATE_CHANGED_CHANNEL,
    );

    expect(handleStateChanged).toBeDefined();
    handleStateChanged?.(
      {} as IpcRendererEvent,
      { revision: 1, status: 'connecting' },
    );
    handleStateChanged?.(
      {} as IpcRendererEvent,
      { revision: 2, status: 'unknown' },
    );
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    expect(boundary.removeListener).toHaveBeenCalledWith(
      CONNECTION_STATE_CHANGED_CHANNEL,
      handleStateChanged,
    );
    expect(
      boundary.listeners.has(CONNECTION_STATE_CHANGED_CHANNEL),
    ).toBe(false);
  });

  it('validates the bounded command approval API and unsubscribe path', async () => {
    const boundary = createIpcBoundary();
    const api = createDesktopApi(boundary.ipc);
    boundary.invoke.mockImplementation(
      async (channel: string, presentationId?: string) => {
        if (channel === COMMAND_APPROVAL_STATE_GET_CHANNEL) {
          return { revision: 0, status: 'idle' };
        }
        if (
          (channel === COMMAND_APPROVAL_APPROVE_CHANNEL ||
            channel === COMMAND_APPROVAL_DENY_CHANNEL) &&
          presentationId === 'presentation/one'
        ) {
          return { accepted: true, reason: 'accepted' };
        }
        return null;
      },
    );

    await expect(api.getCommandApprovalState()).resolves.toEqual({
      revision: 0,
      status: 'idle',
    });
    await expect(
      api.approveCommand('presentation/one'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(api.denyCommand('presentation/one')).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    expect(boundary.invoke).toHaveBeenCalledWith(
      COMMAND_APPROVAL_APPROVE_CHANNEL,
      'presentation/one',
    );
    expect(boundary.invoke).toHaveBeenCalledWith(
      COMMAND_APPROVAL_DENY_CHANNEL,
      'presentation/one',
    );

    const listener = vi.fn();
    const unsubscribe = api.onCommandApprovalStateChanged(listener);
    const handleStateChanged = boundary.listeners.get(
      COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
    );
    handleStateChanged?.(
      {} as IpcRendererEvent,
      { revision: 1, status: 'approved' },
    );
    handleStateChanged?.(
      {} as IpcRendererEvent,
      {
        revision: 2,
        status: 'pending',
        request: { presentationId: 'missing-required-fields' },
      },
    );
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(boundary.listeners.has(
      COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
    )).toBe(false);

    boundary.invoke.mockResolvedValue({
      accepted: true,
      reason: 'stale',
    });
    await expect(
      api.approveCommand('presentation/one'),
    ).rejects.toThrow('invalid command approval result');
  });
});
