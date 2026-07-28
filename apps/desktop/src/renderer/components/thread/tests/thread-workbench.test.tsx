// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThreadWorkbenchView } from '../thread-workbench';
import type { ThreadStore } from '../types';
import { toThreadViewModel } from '../use-store';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

class ResizeObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub);
Element.prototype.scrollIntoView = vi.fn();

const createStore = (
  overrides: Partial<ThreadStore> = {},
): ThreadStore => ({
  thread: toThreadViewModel({
    revision: 4,
    phase: 'ready',
    threadId: 'thr_0000000000000001',
    turns: [
      {
        id: 'turn_0000000000000001',
        status: 'completed',
        messages: [
          {
            id: 'item_0000000000000001',
            role: 'user',
            text: 'Explain the boundary.',
            status: 'completed',
          },
          {
            id: 'item_0000000000000002',
            role: 'agent',
            text: 'The durable event arrives first.',
            status: 'completed',
          },
        ],
      },
    ],
  }),
  draft: '',
  inputBytes: 0,
  inputLimitBytes: 65_536,
  inputHint: '0 / 64 KiB',
  canSend: false,
  canStop: false,
  isSending: false,
  actionError: null,
  setDraft: vi.fn(),
  send: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  ...overrides,
});

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('ThreadWorkbenchView', () => {
  it('preserves completed Turn identities while a later message grows', () => {
    const initial = toThreadViewModel({
      revision: 1,
      phase: 'inProgress',
      threadId: 'thr_0000000000000001',
      activeTurnId: 'turn_0000000000000002',
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          messages: [
            {
              id: 'item_0000000000000001',
              role: 'agent',
              text: 'Stable durable response.',
              status: 'completed',
            },
          ],
        },
        {
          id: 'turn_0000000000000002',
          status: 'inProgress',
          messages: [
            {
              id: 'item_0000000000000002',
              role: 'agent',
              text: 'Mutable',
              status: 'inProgress',
            },
          ],
        },
      ],
    });
    const updated = toThreadViewModel(
      {
        revision: 2,
        phase: 'inProgress',
        threadId: 'thr_0000000000000001',
        activeTurnId: 'turn_0000000000000002',
        turns: [
          {
            id: 'turn_0000000000000001',
            status: 'completed',
            messages: [
              {
                id: 'item_0000000000000001',
                role: 'agent',
                text: 'Stable durable response.',
                status: 'completed',
              },
            ],
          },
          {
            id: 'turn_0000000000000002',
            status: 'inProgress',
            messages: [
              {
                id: 'item_0000000000000002',
                role: 'agent',
                text: 'Mutable tail',
                status: 'inProgress',
              },
            ],
          },
        ],
      },
      initial,
    );

    expect(updated.turns[0]).toBe(initial.turns[0]);
    expect(updated.turns[1]).not.toBe(initial.turns[1]);
  });

  it('renders durable user and Agent messages through view models', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ThreadWorkbenchView store={createStore()} />);
    });
    expect(document.body.textContent).toContain('Explain the boundary.');
    expect(document.body.textContent).toContain(
      'The durable event arrives first.',
    );
    expect(document.body.textContent).toContain('Turn complete');
    expect(document.body.textContent).toContain(
      'Thread thr_0000000000000001',
    );
    expect(
      document.querySelector(
        '[aria-label="Current durable Thread thr_0000000000000001"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector('[aria-label="Conversation transcript"]'),
    ).not.toBeNull();

    await act(async () => root.unmount());
  });

  it('keeps input exact, sends on Enter, and preserves Shift+Enter', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const store = createStore({
      thread: toThreadViewModel({
        revision: 1,
        phase: 'idle',
        turns: [],
      }),
      draft: 'Exact input\n雪',
      inputBytes: 15,
      inputHint: '1 / 64 KiB',
      canSend: true,
    });

    await act(async () => {
      root.render(<ThreadWorkbenchView store={store} />);
    });
    expect(document.body.textContent).toContain('Thread not created');
    expect(
      document.querySelector('[aria-label="No durable Thread yet"]'),
    ).not.toBeNull();
    const textarea = document.querySelector('textarea');
    expect(textarea?.value).toBe('Exact input\n雪');

    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
        }),
      );
    });
    expect(store.send).toHaveBeenCalledOnce();

    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
          shiftKey: true,
        }),
      );
    });
    expect(store.send).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
  });

  it('shows streaming and stopping states without enabling another send', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const store = createStore({
      thread: toThreadViewModel({
        revision: 7,
        phase: 'inProgress',
        threadId: 'thr_0000000000000001',
        activeTurnId: 'turn_0000000000000002',
        turns: [
          {
            id: 'turn_0000000000000002',
            status: 'inProgress',
            messages: [
              {
                id: 'item_0000000000000003',
                role: 'agent',
                text: '',
                status: 'inProgress',
              },
            ],
          },
        ],
      }),
      canStop: true,
    });

    await act(async () => {
      root.render(<ThreadWorkbenchView store={store} />);
    });
    expect(
      document.querySelector('[aria-label="Agent is responding"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      'Thinking through the turn',
    );
    expect(document.querySelector('textarea')?.disabled).toBe(true);
    const stop = document.querySelector(
      '[aria-label="Stop current turn"]',
    ) as HTMLButtonElement;
    await act(async () => stop.click());
    expect(store.stop).toHaveBeenCalledOnce();

    const stoppingStore = createStore({
      thread: toThreadViewModel({
        revision: 8,
        phase: 'stopping',
        threadId: 'thr_0000000000000001',
        activeTurnId: 'turn_0000000000000002',
        turns: [
          {
            id: 'turn_0000000000000002',
            status: 'inProgress',
            messages: [
              {
                id: 'item_0000000000000003',
                role: 'agent',
                text: 'Partial response before stop.',
                status: 'inProgress',
              },
            ],
          },
        ],
      }),
      canStop: true,
    });
    await act(async () => {
      root.render(<ThreadWorkbenchView store={stoppingStore} />);
    });
    expect(
      document.querySelector('[aria-label="Agent response is stopping"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      'Partial response before stop.',
    );
    expect(document.body.textContent).toContain('Stopping');
    expect(
      document.querySelector('[aria-label="Agent is responding"]'),
    ).toBeNull();

    await act(async () => root.unmount());
  });

  it('does not force transcript following after the reader scrolls away', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const store = createStore();

    await act(async () => {
      root.render(<ThreadWorkbenchView store={store} />);
    });
    const viewport = document.querySelector(
      '[aria-label="Conversation transcript"]',
    ) as HTMLDivElement;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, value: 100 },
    });
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    await act(async () => {
      root.render(
        <ThreadWorkbenchView
          store={{
            ...store,
            thread: {
              ...store.thread,
              phase: 'inProgress',
              statusLabel: 'Agent working',
            },
          }}
        />,
      );
    });

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('distinguishes uncertain partial text from active streaming', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const store = createStore({
      thread: toThreadViewModel({
        revision: 8,
        phase: 'unavailable',
        threadId: 'thr_0000000000000001',
        activeTurnId: 'turn_0000000000000002',
        turns: [
          {
            id: 'turn_0000000000000002',
            status: 'inProgress',
            messages: [
              {
                id: 'item_0000000000000003',
                role: 'agent',
                text: 'Keep this exact partial response.',
                status: 'inProgress',
              },
            ],
          },
        ],
        notice: {
          kind: 'connectionLost',
          summary: 'The local Agent connection is unavailable.',
        },
      }),
    });

    await act(async () => {
      root.render(<ThreadWorkbenchView store={store} />);
    });
    expect(
      document.querySelector(
        '[aria-label="Agent response status is unavailable"]',
      ),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      'Keep this exact partial response.',
    );
    expect(document.body.textContent).toContain('Final status unavailable');
    expect(document.body.textContent).not.toContain(
      'Thinking through the turn',
    );
    expect(
      document.querySelector('[aria-label="Agent is responding"]'),
    ).toBeNull();
    expect(document.querySelector('textarea')?.disabled).toBe(true);

    await act(async () => root.unmount());
  });

  it('presents durable retryable failure details without exposing raw diagnostics', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const store = createStore({
      thread: toThreadViewModel({
        revision: 8,
        phase: 'ready',
        threadId: 'thr_0000000000000001',
        turns: [
          {
            id: 'turn_0000000000000003',
            status: 'failed',
            messages: [
              {
                id: 'item_0000000000000004',
                role: 'agent',
                text: '',
                status: 'completed',
              },
            ],
            error: { kind: 'rateLimited', retryable: true },
          },
        ],
      }),
      canSend: false,
    });

    await act(async () => {
      root.render(<ThreadWorkbenchView store={store} />);
    });

    const failure = document.querySelector(
      '[aria-label="Turn failure details"]',
    );
    expect(failure?.getAttribute('role')).toBe('alert');
    expect(failure?.textContent).toContain('The model is rate limited');
    expect(failure?.textContent).toContain(
      'You can send another message to retry.',
    );
    expect(failure?.textContent).toContain('Retryable failure');
    expect(failure?.textContent).not.toContain('rateLimited');
    expect(document.body.textContent).not.toContain(
      'Thinking through the turn',
    );
    expect(
      document.querySelector('[aria-label="Agent response"]'),
    ).toBeNull();

    await act(async () => root.unmount());
  });
});
