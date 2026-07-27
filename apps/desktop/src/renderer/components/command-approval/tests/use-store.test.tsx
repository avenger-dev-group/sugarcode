// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CommandApprovalStateListener,
  CommandApprovalStateSnapshot,
} from '@/shared/command-approval';

import type { CommandApprovalStore } from '../types';
import { useStore } from '../use-store';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const boundary = vi.hoisted(() => ({
  approveCommand: vi.fn(),
  denyCommand: vi.fn(),
  getCommandApprovalState: vi.fn(),
  onCommandApprovalStateChanged: vi.fn(),
}));

vi.mock('@/renderer/services/command-approval', () => boundary);

const pendingSnapshot = (
  revision: number,
): CommandApprovalStateSnapshot => ({
  revision,
  status: 'pending',
  request: {
    presentationId: 'presentation/one',
    command: '/bin/printf',
    arguments: ['%s', 'hello'],
    cwd: '.',
    approvalScope: 'command',
    environmentPolicy: 'minimalV1',
    sandboxed: true,
    sandboxPolicy: 'filesystemReadOnlyV1',
    networkPolicy: 'networkDeniedV1',
    localExpiresAtMs: 121_000,
    actionState: 'awaitingUser',
  },
});

const Probe = ({
  onStore,
}: {
  onStore: (store: CommandApprovalStore) => void;
}) => {
  const store = useStore();
  useEffect(() => {
    onStore(store);
  }, [onStore, store]);
  return <span>{store.snapshot.status}</span>;
};

afterEach(() => {
  vi.useRealTimers();
  boundary.approveCommand.mockReset();
  boundary.denyCommand.mockReset();
  boundary.getCommandApprovalState.mockReset();
  boundary.onCommandApprovalStateChanged.mockReset();
});

describe('command approval useStore', () => {
  it('subscribes before reading, correlates action, and accepts durable terminal state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const order: string[] = [];
    let listener: CommandApprovalStateListener | null = null;
    let resolveSnapshot:
      | ((value: CommandApprovalStateSnapshot) => void)
      | null = null;
    const initial = new Promise<CommandApprovalStateSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const unsubscribe = vi.fn();
    boundary.onCommandApprovalStateChanged.mockImplementation(
      (nextListener: CommandApprovalStateListener) => {
        order.push('subscribe');
        listener = nextListener;
        return unsubscribe;
      },
    );
    boundary.getCommandApprovalState.mockImplementation(() => {
      order.push('get');
      return initial;
    });
    boundary.approveCommand.mockResolvedValue({
      accepted: true,
      reason: 'accepted',
    });
    const stores: CommandApprovalStore[] = [];
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<Probe onStore={(store) => stores.push(store)} />);
    });
    expect(order).toEqual(['subscribe', 'get']);

    await act(async () => {
      listener?.(pendingSnapshot(2));
      resolveSnapshot?.({ revision: 1, status: 'idle' });
      await initial;
    });
    const pendingStore = stores.at(-1);
    expect(pendingStore?.snapshot.status).toBe('pending');
    expect(pendingStore?.secondsRemaining).toBe(120);
    expect(pendingStore?.canAct).toBe(true);

    await act(async () => {
      await pendingStore?.approve();
    });
    expect(boundary.approveCommand).toHaveBeenCalledWith(
      'presentation/one',
    );

    await act(async () => {
      listener?.({ revision: 3, status: 'approved' });
    });
    expect(stores.at(-1)?.statusMessage).toContain(
      'recorded decision is complete',
    );
    expect(container.textContent).toBe('approved');

    await act(async () => {
      root.unmount();
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('disables actions at the local deadline and reports stale responses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let listener: CommandApprovalStateListener | null = null;
    boundary.onCommandApprovalStateChanged.mockImplementation(
      (nextListener: CommandApprovalStateListener) => {
        listener = nextListener;
        return vi.fn();
      },
    );
    boundary.getCommandApprovalState.mockResolvedValue({
      revision: 0,
      status: 'idle',
    });
    boundary.denyCommand.mockResolvedValue({
      accepted: false,
      reason: 'stale',
    });
    const stores: CommandApprovalStore[] = [];
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<Probe onStore={(store) => stores.push(store)} />);
      await Promise.resolve();
    });
    await act(async () => {
      listener?.(pendingSnapshot(1));
    });
    const activeStore = stores.at(-1);
    await act(async () => {
      await activeStore?.deny();
    });
    expect(stores.at(-1)?.actionError).toContain('no longer active');

    await act(async () => {
      vi.setSystemTime(121_000);
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(stores.at(-1)?.secondsRemaining).toBe(0);
    expect(stores.at(-1)?.canAct).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });
});
