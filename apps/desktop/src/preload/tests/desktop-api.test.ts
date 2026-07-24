import type { IpcRendererEvent } from 'electron';

import { describe, expect, it, vi } from 'vitest';

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
});
