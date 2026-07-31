// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

const workspaceNavigation = vi.hoisted(() => ({
  state: {
    revision: 1,
    generation: 1,
    status: 'ready' as const,
    kind: 'project' as 'project' | 'chat',
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
  workspaceNavigation.state.kind = 'project';
  workspaceNavigation.state.projectThreadIds = [
    'thr_0000000000000002',
    'thr_0000000000000001',
  ];
  workspaceNavigation.state.chatThreadIds = [];
  workspaceNavigation.busy = false;
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
    expect(current?.textContent).toBe('任务 0002');
    expect(current?.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(document.body.textContent).not.toContain('当前任务');
    expect(
      document.querySelector('[aria-expanded="true"]')?.tagName,
    ).toBe('BUTTON');
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
    expect(
      current?.parentElement?.classList.contains('transition-colors'),
    ).toBe(false);
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
    expect(
      items.every(
        (item) =>
          item.classList.contains('cursor-default') &&
          !item.classList.contains('cursor-not-allowed'),
      ),
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
    expect(document.body.textContent).toContain('任务 0002');
    expect(document.body.textContent).not.toContain('当前任务');
    expect(
      document.querySelectorAll('[data-thread-item]'),
    ).toHaveLength(2);
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-thread-item]'),
      ).some((item) => item.classList.contains('opacity-60')),
    ).toBe(false);
    await act(async () => root.unmount());
  });

  it('does not insert a synthetic current row outside the remembered index', async () => {
    workspaceNavigation.state.projectThreadIds = [
      'thr_0000000000000001',
    ];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(<ThreadNavigator store={createStore()} />),
    );

    expect(
      document.querySelectorAll('[data-thread-item]'),
    ).toHaveLength(1);
    expect(document.querySelector('[aria-current="page"]')).toBeNull();
    expect(document.body.textContent).toContain('任务 0001');
    expect(document.body.textContent).not.toContain('当前任务');
    await act(async () => root.unmount());
  });

  it('keeps row titles and DOM identity stable across a pending selection', async () => {
    const thread18 = 'thr_0000000000000018';
    const thread19 = 'thr_0000000000000019';
    workspaceNavigation.state.projectThreadIds = [thread18, thread19];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const base = createStore();
    const navigator = {
      ...base.navigator,
      threadIds: [thread18, thread19],
      selectedThreadId: thread18,
    };

    await act(async () =>
      root.render(
        <ThreadNavigator
          store={{
            ...base,
            navigator: { ...navigator, pendingThreadId: null },
          }}
        />,
      ),
    );
    const initialRows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-thread-item]'),
    );
    expect(initialRows.map((row) => row.textContent)).toEqual([
      '任务 0018',
      '任务 0019',
    ]);
    expect(
      document.querySelector('[aria-current="page"]')?.textContent,
    ).toBe('任务 0018');

    await act(async () =>
      root.render(
        <ThreadNavigator
          store={{
            ...base,
            navigator: { ...navigator, pendingThreadId: thread19 },
          }}
        />,
      ),
    );
    const pendingRows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-thread-item]'),
    );
    expect(pendingRows).toEqual(initialRows);
    expect(pendingRows.map((row) => row.textContent)).toEqual([
      '任务 0018',
      '任务 0019',
    ]);
    expect(
      document.querySelector('[aria-current="page"]')?.textContent,
    ).toBe('任务 0019');

    await act(async () =>
      root.render(
        <ThreadNavigator
          store={{
            ...base,
            navigator: {
              ...navigator,
              selectedThreadId: thread19,
              pendingThreadId: null,
            },
          }}
        />,
      ),
    );
    const completedRows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-thread-item]'),
    );
    expect(completedRows).toEqual(initialRows);
    expect(completedRows.map((row) => row.textContent)).toEqual([
      '任务 0018',
      '任务 0019',
    ]);
    expect(
      document.querySelector('[aria-current="page"]')?.textContent,
    ).toBe('任务 0019');
    await act(async () => root.unmount());
  });

  it('keeps project disclosure under user control while activating Chat', async () => {
    const chatThreadId = 'thr_0000000000000019';
    workspaceNavigation.state.chatThreadIds = [chatThreadId];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const base = createStore();
    const store = createStore({
      navigator: {
        ...base.navigator,
        selectedThreadId: chatThreadId,
      },
    });

    await act(async () => root.render(<ThreadNavigator store={store} />));
    expect(
      document.querySelectorAll('[data-thread-item]'),
    ).toHaveLength(3);

    await act(async () => {
      document
        .querySelector<HTMLElement>(
          `[aria-label="Thread ${chatThreadId}"]`,
        )
        ?.click();
    });
    expect(workspaceNavigation.activateChat).toHaveBeenCalledWith(
      chatThreadId,
    );
    expect(
      document.querySelector('#project-thread-list'),
    ).not.toBeNull();
    const collapse = document.querySelector<HTMLButtonElement>(
      'button[aria-label="收起 sugarcode 会话"]',
    );
    expect(
      collapse?.classList.contains('aria-expanded:bg-transparent'),
    ).toBe(true);
    expect(collapse?.classList.contains('hover:bg-transparent')).toBe(
      true,
    );

    workspaceNavigation.state.kind = 'chat';
    await act(async () => root.render(<ThreadNavigator store={store} />));
    expect(
      document.querySelector('[aria-current="page"]')?.textContent,
    ).toBe('聊天 0019');
    expect(
      document.querySelector('#project-thread-list'),
    ).not.toBeNull();

    await act(async () => collapse?.click());
    expect(workspaceNavigation.resumeProject).not.toHaveBeenCalled();
    expect(
      document.querySelector('#project-thread-list'),
    ).toBeNull();
    expect(
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="展开 sugarcode 会话"]',
        )
        ?.querySelector('svg')
        ?.classList.contains('-rotate-90'),
    ).toBe(true);
    expect(
      document.querySelector('[aria-current="page"]')?.textContent,
    ).toBe('聊天 0019');

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="展开 sugarcode 会话"]',
        )
        ?.click();
    });
    expect(
      document.querySelector('#project-thread-list'),
    ).not.toBeNull();
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
