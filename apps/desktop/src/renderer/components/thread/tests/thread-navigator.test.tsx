// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThreadNavigator } from '../thread-navigator';
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

const createStore = (
  overrides: Partial<ThreadStore> = {},
): ThreadStore => ({
  thread: toThreadViewModel({
    revision: 1,
    phase: 'ready',
    threadId: 'thr_0000000000000002',
    turns: [],
  }),
  navigator: {
    status: 'ready',
    query: '',
    searchStatus: 'idle',
    threadIds: [
      'thr_0000000000000002',
      'thr_0000000000000001',
    ],
    selectedThreadId: 'thr_0000000000000002',
    pendingThreadId: null,
    pendingMutation: null,
    archivedUndoThreadId: null,
    truncated: false,
    statusLabel: '2 active Threads',
  },
  navigatorOpen: true,
  draft: '',
  inputBytes: 0,
  inputLimitBytes: 65_536,
  inputHint: '0 / 64 KiB',
  canSend: false,
  canStop: false,
  isSending: false,
  actionError: null,
  setDraft: vi.fn(),
  setNavigatorOpen: vi.fn(),
  searchThreads: vi.fn(async () => undefined),
  selectThread: vi.fn(async () => undefined),
  forkThread: vi.fn(async () => undefined),
  archiveThread: vi.fn(async () => undefined),
  unarchiveThread: vi.fn(async () => undefined),
  deleteThread: vi.fn(async () => undefined),
  send: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  ...overrides,
});

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('ThreadNavigator', () => {
  it('exposes the current Thread and submits bounded search text', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const searchThreads = vi.fn(async () => undefined);
    const store = createStore({ searchThreads });

    await act(async () => root.render(<ThreadNavigator store={store} />));
    expect(
      document.querySelector('[aria-current="page"]')?.getAttribute(
        'aria-label',
      ),
    ).toBe('Current Thread thr_0000000000000002');

    const input = document.querySelector(
      '#thread-search',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'durable truth');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Search Threads"]',
        )
        ?.click();
    });
    expect(searchThreads).toHaveBeenCalledWith('durable truth');
    await act(async () => root.unmount());
  });

  it('supports arrow navigation and fails closed during an active Turn', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const selectThread = vi.fn(async () => undefined);
    const base = createStore();
    const store = createStore({
      thread: { ...base.thread, phase: 'inProgress' },
      selectThread,
    });

    await act(async () => root.render(<ThreadNavigator store={store} />));
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-thread-button]'),
    );
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    buttons[0]?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
      }),
    );
    expect(selectThread).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('keeps the current Thread visible outside bounded search results', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const store = createStore({
      navigator: {
        status: 'ready',
        query: 'historical',
        searchStatus: 'ready',
        threadIds: ['thr_0000000000000001'],
        selectedThreadId: 'thr_0000000000000002',
        pendingThreadId: null,
        pendingMutation: null,
        archivedUndoThreadId: null,
        truncated: true,
        statusLabel: '1 matching Thread',
      },
    });

    await act(async () => root.render(<ThreadNavigator store={store} />));
    expect(document.body.textContent).toContain('Current');
    expect(document.body.textContent).toContain('First 50 shown');
    expect(
      document.querySelectorAll('[data-thread-button]'),
    ).toHaveLength(2);
    await act(async () => root.unmount());
  });

  it('forks and archives from the row while delete requires confirmation', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const forkThread = vi.fn(async () => undefined);
    const archiveThread = vi.fn(async () => undefined);
    const deleteThread = vi.fn(async () => undefined);
    const store = createStore({
      forkThread,
      archiveThread,
      deleteThread,
    });
    const threadId = 'thr_0000000000000002';

    await act(async () => root.render(<ThreadNavigator store={store} />));
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `button[aria-label="Fork Thread ${threadId}"]`,
        )
        ?.click();
      document
        .querySelector<HTMLButtonElement>(
          `button[aria-label="Archive Thread ${threadId}"]`,
        )
        ?.click();
    });
    expect(forkThread).toHaveBeenCalledWith(threadId);
    expect(archiveThread).toHaveBeenCalledWith(threadId);

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `button[aria-label="Delete Thread ${threadId}"]`,
        )
        ?.click();
    });
    expect(deleteThread).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Delete durable Thread?',
    );
    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Delete permanently')
        ?.click();
    });
    expect(deleteThread).toHaveBeenCalledWith(threadId);
    await act(async () => root.unmount());
  });

  it('offers one-level archive undo and blocks lifecycle actions while pending', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const unarchiveThread = vi.fn(async () => undefined);
    const base = createStore();
    const archivedThreadId = 'thr_0000000000000001';
    const store = createStore({
      navigator: {
        ...base.navigator,
        archivedUndoThreadId: archivedThreadId,
        pendingMutation: {
          kind: 'archive',
          threadId: 'thr_0000000000000002',
        },
      },
      unarchiveThread,
    });

    await act(async () => root.render(<ThreadNavigator store={store} />));
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          'button[aria-label^="Fork Thread"]',
        ),
      ).every((button) => button.disabled),
    ).toBe(true);
    const undo = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Undo'),
    ) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);

    await act(async () =>
      root.render(
        <ThreadNavigator
          store={{
            ...store,
            navigator: {
              ...store.navigator,
              pendingMutation: null,
            },
          }}
        />,
      ),
    );
    await act(async () => {
      (
        Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent?.includes('Undo'),
        ) as HTMLButtonElement
      ).click();
    });
    expect(unarchiveThread).toHaveBeenCalledWith(archivedThreadId);
    await act(async () => root.unmount());
  });
});
