// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionStateListener } from '@/shared/connection';

import { useStore } from './use-store';

const boundary = vi.hoisted(() => ({
  getConnectionState: vi.fn(),
  onConnectionStateChanged: vi.fn(),
}));

vi.mock('@/renderer/services/connection', () => boundary);

const Probe = ({
  onLabel,
}: {
  onLabel: (label: string) => void;
}) => {
  const { connection } = useStore();
  useEffect(() => {
    onLabel(connection.label);
  }, [connection.label, onLabel]);
  return <span>{connection.label}</span>;
};

afterEach(() => {
  boundary.getConnectionState.mockReset();
  boundary.onConnectionStateChanged.mockReset();
});

describe('connection useStore', () => {
  it('subscribes before reading and ignores an older snapshot', async () => {
    const order: string[] = [];
    const labels: string[] = [];
    let listener: ConnectionStateListener | null = null;
    let resolveSnapshot: ((value: { revision: number; status: 'connecting' }) => void) | null =
      null;
    const snapshot = new Promise<{ revision: number; status: 'connecting' }>(
      (resolve) => {
        resolveSnapshot = resolve;
      },
    );
    const unsubscribe = vi.fn();
    boundary.onConnectionStateChanged.mockImplementation(
      (nextListener: ConnectionStateListener) => {
        order.push('subscribe');
        listener = nextListener;
        return unsubscribe;
      },
    );
    boundary.getConnectionState.mockImplementation(() => {
      order.push('get');
      return snapshot;
    });

    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe onLabel={(label) => labels.push(label)} />);
    });
    expect(order).toEqual(['subscribe', 'get']);

    await act(async () => {
      listener?.({ revision: 2, status: 'ready' });
      resolveSnapshot?.({ revision: 1, status: 'connecting' });
      await snapshot;
    });
    expect(container.textContent).toBe('Ready');
    expect(labels.at(-1)).toBe('Ready');

    await act(async () => {
      root.unmount();
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
