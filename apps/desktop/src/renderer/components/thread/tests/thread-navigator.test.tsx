// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

const workspaceNavigation = vi.hoisted(() => ({
  state: {
    revision: 1,
    generation: 1,
    status: 'ready' as const,
    kind: 'project' as const,
    name: 'sugarcode',
    projectName: 'sugarcode',
    projectThreadIds: [
      'thr_0000000000000002',
      'thr_0000000000000001',
    ],
    chatThreadIds: [] as string[],
  },
  busy: false,
  error: null as string | null,
  chooseProject: vi.fn(async () => true),
  resumeProject: vi.fn(async () => true),
  activateChat: vi.fn(async () => true),
}));

vi.mock(
  '@/renderer/components/workspace/navigation/use-store',
  () => ({
    useStore: () => workspaceNavigation,
  }),
);

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
  startNewThread: vi.fn(async () => undefined),
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
  it('renders project and Thread navigation as spans without search controls', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const store = createStore();

    await act(async () => root.render(<ThreadNavigator store={store} />));
    const current = document.querySelector('[aria-current="page"]');
    expect(current?.tagName).toBe('SPAN');
    expect(current?.getAttribute('aria-label')).toBe(
      'Current Thread thr_0000000000000002',
    );
    expect(
      document.querySelector('[aria-expanded="true"]')?.tagName,
    ).toBe('SPAN');
    expect(document.querySelector('#thread-search')).toBeNull();
    expect(
      document.querySelector('button[aria-label="Search Threads"]'),
    ).toBeNull();
    const projectRow = document.querySelector('[data-project-row]');
    expect(projectRow?.classList.contains('bg-surface-hover/70')).toBe(
      false,
    );
    expect(projectRow?.classList.contains('hover:bg-surface-hover')).toBe(
      false,
    );
    expect(
      current?.parentElement?.classList.contains('bg-surface-hover'),
    ).toBe(true);
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
    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[data-thread-item]'),
    );
    expect(items).toHaveLength(2);
    expect(
      items.every((item) => item.getAttribute('aria-disabled') === 'true'),
    ).toBe(true);
    items[0]?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
      }),
    );
    expect(selectThread).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('keeps the remembered project list stable while the runtime reconnects', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const store = createStore({
      navigator: {
        status: 'loading',
        threadIds: ['thr_0000000000000001'],
        selectedThreadId: 'thr_0000000000000002',
        pendingThreadId: null,
        pendingMutation: null,
        archivedUndoThreadId: null,
        truncated: false,
        statusLabel: 'Loading active Threads',
      },
    });

    await act(async () => root.render(<ThreadNavigator store={store} />));
    expect(document.body.textContent).toContain('当前任务');
    expect(
      document.querySelectorAll('[data-thread-item]'),
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
      '永久删除这个对话？',
    );
    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === '永久删除')
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
      (button) => button.textContent?.includes('撤销'),
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
          (button) => button.textContent?.includes('撤销'),
        ) as HTMLButtonElement
      ).click();
    });
    expect(unarchiveThread).toHaveBeenCalledWith(archivedThreadId);
    await act(async () => root.unmount());
  });

  it('renders Chat as a peer section and creates a new chat from its plus action', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const startNewThread = vi.fn(async () => undefined);
    const store = createStore({ startNewThread });

    await act(async () => root.render(<ThreadNavigator store={store} />));
    expect(document.body.textContent).toContain('项目');
    expect(document.body.textContent).toContain('聊天');

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="新建聊天"]',
        )
        ?.click();
    });

    expect(workspaceNavigation.activateChat).toHaveBeenCalledWith();
    expect(startNewThread).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
