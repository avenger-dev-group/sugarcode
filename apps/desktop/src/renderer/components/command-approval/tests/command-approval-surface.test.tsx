// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CommandApprovalView,
} from '../command-approval-surface';
import type {
  CommandApprovalRequestViewModel,
  CommandApprovalStore,
} from '../types';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

class ResizeObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

const longArgument = `${'long-value-'.repeat(80)}雪\nsecond line`;

const commandRequest: CommandApprovalRequestViewModel = {
  presentationId: 'presentation/one',
  command: '/usr/bin/printf',
  arguments: ['%s; not shell', 'hello world', longArgument],
  cwd: '.',
  approvalScope: 'command',
  environmentPolicy: 'minimalV1',
  sandboxed: true,
  sandboxPolicy: 'filesystemReadOnlyV1',
  networkPolicy: 'networkDeniedV1',
  localExpiresAtMs: 121_000,
  actionState: 'awaitingUser',
};

const createStore = (
  overrides: Partial<CommandApprovalStore> = {},
): CommandApprovalStore => ({
  snapshot: {
    revision: 1,
    status: 'pending',
    request: commandRequest,
  },
  request: commandRequest,
  isOpen: true,
  canAct: true,
  secondsRemaining: 120,
  statusMessage: 'Command approval pending.',
  actionError: null,
  approve: vi.fn(async () => undefined),
  deny: vi.fn(async () => undefined),
  ...overrides,
});

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('CommandApprovalView', () => {
  it('shows exact argv items and policies without constructing shell text', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const store = createStore();

    await act(async () => {
      root.render(<CommandApprovalView store={store} />);
    });
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Allow this command once?');
    expect(dialog?.textContent).toContain('"/usr/bin/printf"');
    expect(dialog?.textContent).toContain('argv[1]');
    expect(dialog?.textContent).toContain('"%s; not shell"');
    expect(dialog?.textContent).toContain('"hello world"');
    expect(dialog?.textContent).toContain(JSON.stringify(longArgument));
    expect(dialog?.textContent).toContain('filesystemReadOnlyV1');
    expect(dialog?.textContent).toContain('networkDeniedV1');
    expect(dialog?.textContent).toContain('minimalV1');
    expect(dialog?.textContent).not.toContain(
      '/usr/bin/printf %s; not shell',
    );
    expect(
      document.querySelector(
        '[aria-label="Command arguments in argv order"]',
      )?.tagName,
    ).toBe('OL');
    expect(
      document.querySelector('[aria-label="Command approval details"]'),
    ).toHaveProperty('tabIndex', 0);

    const denyButton = Array.from(
      document.querySelectorAll('button'),
    ).find((button) => button.textContent === 'Deny');
    expect(document.activeElement).toBe(denyButton);

    await act(async () => {
      dialog?.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Escape',
        }),
      );
    });
    expect(store.deny).toHaveBeenCalledOnce();

    const approveButton = Array.from(
      document.querySelectorAll('button'),
    ).find((button) => button.textContent === 'Approve once & run');
    await act(async () => {
      approveButton?.click();
    });
    expect(store.approve).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
    });
  });

  it('renders disabled elapsed state and non-modal durable terminal status', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const elapsed = createStore({
      canAct: false,
      secondsRemaining: 0,
      request: {
        ...commandRequest,
        actionState: 'localWindowElapsed',
      },
    });

    await act(async () => {
      root.render(<CommandApprovalView store={elapsed} />);
    });
    expect(document.body.textContent).toContain(
      'local approval window elapsed',
    );
    expect(
      Array.from(document.querySelectorAll('button')).every(
        (button) => button.disabled,
      ),
    ).toBe(true);

    await act(async () => {
      root.render(
        <CommandApprovalView
          store={createStore({
            snapshot: { revision: 2, status: 'expired' },
            request: null,
            isOpen: false,
            canAct: false,
            secondsRemaining: 0,
            statusMessage:
              'Command approval expired. Nothing was run.',
          })}
        />,
      );
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'Nothing was run',
    );

    await act(async () => {
      root.unmount();
    });
  });
});
