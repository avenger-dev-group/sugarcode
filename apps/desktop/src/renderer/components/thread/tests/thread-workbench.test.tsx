// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  '@/renderer/components/workspace/navigation/use-store',
  () => ({
    useStore: () => ({
      state: {
        revision: 1,
        generation: 1,
        status: 'ready',
        kind: 'project',
        name: 'sugarcode',
        projectName: 'sugarcode',
        projectThreadIds: [] as string[],
        chatThreadIds: [] as string[],
      },
      busy: false,
      error: null as string | null,
      chooseProject: vi.fn(async () => true),
      resumeProject: vi.fn(async () => true),
      activateChat: vi.fn(async () => true),
    }),
  }),
);

import { ThreadWorkbenchView } from '../thread-workbench';
import type { ThreadStore } from '../types';
import { toThreadViewModel } from '../use-store';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  readonly callback: ResizeObserverCallback;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  trigger = (): void => {
    this.callback([], this as unknown as ResizeObserver);
  };
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub);
Element.prototype.scrollIntoView = vi.fn();

const createStore = (overrides: Partial<ThreadStore> = {}): ThreadStore => ({
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
  navigator: {
    status: 'ready',
    query: '',
    searchStatus: 'idle',
    threadIds: ['thr_0000000000000001'],
    selectedThreadId: 'thr_0000000000000001',
    pendingThreadId: null,
    pendingMutation: null,
    archivedUndoThreadId: null,
    truncated: false,
    statusLabel: '1 active Thread',
  },
  navigatorOpen: false,
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
  ResizeObserverStub.instances = [];
  vi.clearAllMocks();
});

describe('ThreadWorkbenchView', () => {
  it('renders process commentary before the tool activity it introduces', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const thread = toThreadViewModel({
      revision: 5,
      phase: 'ready',
      threadId: 'thr_0000000000000001',
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          messages: [],
          activities: [
            {
              type: 'commentary',
              activity: {
                id: 'item_commentary',
                text: 'I will inspect the workspace first.',
                status: 'completed',
              },
            },
            {
              type: 'workspaceRead',
              activity: {
                id: 'item_tool',
                callId: 'call_1',
                path: 'README.md',
                callStatus: 'completed',
                result: {
                  id: 'item_result',
                  status: 'completed',
                  outcome: { type: 'success', bytes: 12 },
                },
              },
            },
          ],
        },
      ],
    });

    await act(async () => {
      root.render(<ThreadWorkbenchView store={createStore({ thread })} />);
    });

    const commentary = document.querySelector(
      '[aria-label="Agent progress update"]',
    );
    const process = document.querySelector(
      'details[aria-label="Processed activity"]',
    );
    const tool = document.querySelector(
      '[aria-label="Workspace read complete: README.md"]',
    );
    expect(process?.hasAttribute('open')).toBe(false);
    expect(commentary?.textContent).toBe('I will inspect the workspace first.');
    expect(commentary).not.toBeNull();
    expect(tool).not.toBeNull();
    if (!commentary || !tool) {
      throw new Error('Expected commentary and tool activity.');
    }
    expect(
      commentary.compareDocumentPosition(tool) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await act(async () => root.unmount());
  });

  it('groups consecutive workspace activity into a compact collapsible process log', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const thread = toThreadViewModel({
      revision: 6,
      phase: 'ready',
      threadId: 'thr_0000000000000001',
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          messages: [],
          activities: [
            {
              type: 'workspaceList',
              activity: {
                id: 'item_list',
                callId: 'call_list',
                path: '.',
                callStatus: 'completed',
                result: {
                  id: 'item_list_result',
                  status: 'completed',
                  outcome: { type: 'success', entries: 3 },
                },
              },
            },
            {
              type: 'workspaceRead',
              activity: {
                id: 'item_read',
                callId: 'call_read',
                path: 'src/main.ts',
                callStatus: 'completed',
                result: {
                  id: 'item_read_result',
                  status: 'completed',
                  outcome: { type: 'success', bytes: 13_312 },
                },
              },
            },
            {
              type: 'workspaceSearch',
              activity: {
                id: 'item_search',
                callId: 'call_search',
                path: 'src',
                query: 'render',
                callStatus: 'completed',
                result: {
                  id: 'item_search_result',
                  status: 'completed',
                  outcome: {
                    type: 'success',
                    matches: 17,
                    truncated: false,
                  },
                },
              },
            },
          ],
        },
      ],
    });

    await act(async () => {
      root.render(<ThreadWorkbenchView store={createStore({ thread })} />);
    });

    const group = document.querySelector(
      'details[aria-label="3 tool activities"]',
    );
    const process = document.querySelector(
      'details[aria-label="Processed activity"]',
    );
    expect(group).not.toBeNull();
    expect(group?.hasAttribute('open')).toBe(false);
    expect(process?.hasAttribute('open')).toBe(false);
    expect(group?.className).not.toContain('rounded-xl');
    expect(group?.textContent).toContain(
      'Listed a directory, read 1 file and searched the workspace',
    );
    expect(group?.textContent).toContain('13 KB');
    expect(group?.textContent).toContain('3 entries');
    expect(group?.textContent).toContain('17 matches');
    expect(
      group?.querySelectorAll(
        '[aria-label^="Workspace list"], [aria-label^="Workspace read"], [aria-label^="Workspace search"]',
      ),
    ).toHaveLength(3);

    await act(async () => root.unmount());
  });

  it('keeps the composer in flow after the scrollable transcript', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ThreadWorkbenchView store={createStore()} />);
    });

    const transcript = document.querySelector(
      '[data-layout="conversation-scroll"]',
    ) as HTMLElement;
    const composer = document.querySelector(
      '[data-layout="conversation-composer"]',
    ) as HTMLElement;
    expect(transcript.parentElement).toBe(composer.parentElement);
    expect(
      transcript.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(composer.className).toContain('shrink-0');
    expect(composer.className).not.toContain('absolute');

    await act(async () => root.unmount());
  });

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
    expect(document.body.textContent).not.toContain('Turn complete');
    expect(document.body.textContent).not.toContain(
      'Turn turn_0000000000000001',
    );
    expect(document.querySelector('[aria-label^="Durable Turn "]')).toBeNull();
    expect(document.querySelector('[aria-label^="Durable Item "]')).toBeNull();
    const userMessage = document.querySelector('[aria-label="Your message"]');
    expect(userMessage?.className).toContain('bg-user-message');
    expect(userMessage?.className).toContain('text-user-message-foreground');
    expect(userMessage?.parentElement?.className).toContain('w-fit');
    expect(userMessage?.parentElement?.className).toContain('max-w-[82%]');
    const agentResponse = document.querySelector(
      '[aria-label="Agent response"]',
    );
    expect(agentResponse?.textContent).not.toContain('SugarCode');
    expect(agentResponse?.textContent).not.toContain('SC');
    expect(agentResponse?.className).not.toContain('grid-cols');
    expect(document.body.textContent).not.toContain(
      'Thread thr_0000000000000001',
    );
    expect(
      document.querySelector(
        '[aria-label="Current durable Thread thr_0000000000000001"]',
      ),
    ).toBeNull();
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
    expect(document.body.textContent).not.toContain('Thread not created');
    expect(
      document.querySelector('[aria-label="No durable Thread yet"]'),
    ).toBeNull();
    expect(document.querySelector('[aria-label^="Durable Turn "]')).toBeNull();
    expect(document.querySelector('[aria-label^="Durable Item "]')).toBeNull();
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
    expect(document.body.textContent).not.toContain(
      'Turn turn_0000000000000002',
    );
    expect(
      document.querySelector(
        '[aria-label="Durable Item item_0000000000000003"]',
      ),
    ).toBeNull();
    expect(document.body.textContent).toContain('Thinking through the turn');
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
      scrollTop: {
        configurable: true,
        value: 800,
        writable: true,
      },
    });
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    const transcriptContent = viewport.firstElementChild?.firstElementChild;
    const contentObserver = ResizeObserverStub.instances.find((observer) =>
      observer.observe.mock.calls.some(
        ([target]) => target === transcriptContent,
      ),
    );
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      value: 1_400,
    });
    contentObserver?.trigger();
    expect(viewport.scrollTop).toBe(100);

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
    expect(viewport.scrollTop).toBe(100);

    viewport.scrollTop = 1_000;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    await act(async () => {
      root.render(
        <ThreadWorkbenchView
          store={{
            ...store,
            thread: {
              ...store.thread,
              phase: 'ready',
              statusLabel: 'Ready for the next turn',
            },
          }}
        />,
      );
    });
    expect(viewport.scrollTop).toBe(1_400);

    await act(async () => root.unmount());
  });

  it('shows the latest content after the user selects a Thread', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const selectedStore = createStore();
    const idleStore = createStore({
      thread: toThreadViewModel({
        revision: 1,
        phase: 'idle',
        turns: [],
      }),
      navigator: {
        ...selectedStore.navigator,
        selectedThreadId: null,
      },
    });

    await act(async () => {
      root.render(<ThreadWorkbenchView store={idleStore} />);
    });
    const viewport = document.querySelector(
      '[aria-label="Conversation transcript"]',
    ) as HTMLDivElement;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1_800 },
      scrollTop: {
        configurable: true,
        value: 0,
        writable: true,
      },
    });

    await act(async () => {
      root.render(
        <ThreadWorkbenchView
          store={{
            ...idleStore,
            thread: selectedStore.thread,
            navigator: selectedStore.navigator,
          }}
        />,
      );
    });

    expect(viewport.scrollTop).toBe(1_800);
    const transcriptContent = viewport.firstElementChild?.firstElementChild;
    const contentObserver = ResizeObserverStub.instances.find((observer) =>
      observer.observe.mock.calls.some(
        ([target]) => target === transcriptContent,
      ),
    );
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      value: 2_400,
    });
    contentObserver?.trigger();
    expect(viewport.scrollTop).toBe(2_400);
    await act(async () => root.unmount());
  });

  it('follows a growing Agent response while the reader remains at the bottom', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const store = createStore({
      thread: toThreadViewModel({
        revision: 1,
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
                text: 'First chunk',
                status: 'inProgress',
              },
            ],
          },
        ],
      }),
    });

    await act(async () => {
      root.render(<ThreadWorkbenchView store={store} />);
    });
    const viewport = document.querySelector(
      '[aria-label="Conversation transcript"]',
    ) as HTMLDivElement;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1_600 },
      scrollTop: {
        configurable: true,
        value: 0,
        writable: true,
      },
    });
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    await act(async () => {
      root.render(
        <ThreadWorkbenchView
          store={{
            ...store,
            thread: toThreadViewModel(
              {
                revision: 2,
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
                        text: 'First chunk and the next chunk',
                        status: 'inProgress',
                      },
                    ],
                  },
                ],
              },
              store.thread,
            ),
          }}
        />,
      );
    });

    expect(viewport.scrollTop).toBe(1_600);
    await act(async () => root.unmount());
  });

  it('resumes following for a new user message after the reader scrolled up', async () => {
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
      scrollTop: {
        configurable: true,
        value: 800,
        writable: true,
      },
    });
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    await act(async () => {
      root.render(
        <ThreadWorkbenchView
          store={{
            ...store,
            thread: toThreadViewModel(
              {
                revision: 5,
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
                  {
                    id: 'turn_0000000000000002',
                    status: 'inProgress',
                    messages: [
                      {
                        id: 'item_0000000000000003',
                        role: 'user',
                        text: 'Continue.',
                        status: 'completed',
                      },
                    ],
                  },
                ],
              },
              store.thread,
            ),
          }}
        />,
      );
    });

    expect(viewport.scrollTop).toBe(1_200);
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
    expect(document.body.textContent).not.toContain(
      'Turn turn_0000000000000002',
    );
    expect(
      document.querySelector(
        '[aria-label="Durable Item item_0000000000000003"]',
      ),
    ).toBeNull();
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

  it('presents the exact durable retryable failure kind without exposing raw diagnostics', async () => {
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
    const exactKind = failure?.querySelector(
      '[aria-label="Exact Turn failure kind rateLimited"]',
    );
    expect(exactKind?.textContent).toBe('rateLimited');
    expect(exactKind?.className).toContain('break-all');
    expect(exactKind?.className).not.toContain('uppercase');
    expect(failure?.querySelector('button, a')).toBeNull();
    expect(
      document.querySelector(
        '[aria-label="Durable Item item_0000000000000004"]',
      ),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      'Thinking through the turn',
    );
    expect(document.querySelector('[aria-label="Agent response"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it('presents a durable workspace read without exposing file content or controls', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const longPath = `${'nested/'.repeat(20)}notes.txt`;
    const store = createStore({
      thread: toThreadViewModel({
        revision: 9,
        phase: 'ready',
        threadId: 'thr_0000000000000001',
        turns: [
          {
            id: 'turn_0000000000000004',
            status: 'completed',
            messages: [
              {
                id: 'item_0000000000000005',
                role: 'user',
                text: 'Read the notes.',
                status: 'completed',
              },
              {
                id: 'item_0000000000000008',
                role: 'agent',
                text: 'The notes were read.',
                status: 'completed',
              },
            ],
            workspaceRead: {
              id: 'item_0000000000000006',
              callId: 'call_read',
              path: longPath,
              callStatus: 'completed',
              result: {
                id: 'item_0000000000000007',
                status: 'completed',
                outcome: { type: 'success', bytes: 4_096 },
              },
            },
          },
        ],
      }),
    });

    await act(async () => {
      root.render(<ThreadWorkbenchView store={store} />);
    });

    const activity = document.querySelector(
      `[aria-label="Workspace read complete: ${longPath}"]`,
    );
    expect(activity?.getAttribute('role')).toBe('status');
    expect(activity?.getAttribute('data-state')).toBe('succeeded');
    expect(activity?.textContent).toContain('workspace/read');
    expect(activity?.textContent).toContain(longPath);
    expect(activity?.textContent).toContain('4,096 bytes read');
    expect(activity?.querySelector('code')?.className).toContain('break-all');
    expect(activity?.querySelector('button, a')).toBeNull();
    expect(activity?.textContent).not.toContain('call_read');
    expect(activity?.textContent).not.toContain('item_0000000000000006');
    const transcript = document.body.textContent ?? '';
    expect(transcript.indexOf('Read the notes.')).toBeLessThan(
      transcript.indexOf('Workspace read complete'),
    );
    expect(transcript.indexOf('Workspace read complete')).toBeLessThan(
      transcript.indexOf('The notes were read.'),
    );

    await act(async () => root.unmount());
  });

  it('derives honest workspace read states from lifecycle truth', () => {
    const activeSnapshot = {
      revision: 10,
      threadId: 'thr_0000000000000001',
      activeTurnId: 'turn_0000000000000005',
      turns: [
        {
          id: 'turn_0000000000000005',
          status: 'inProgress' as const,
          messages: [] as const,
          workspaceRead: {
            id: 'item_0000000000000009',
            callId: 'call_pending',
            path: 'pending.txt',
            callStatus: 'completed' as const,
          },
        },
      ],
    };

    expect(
      toThreadViewModel({ ...activeSnapshot, phase: 'inProgress' }).turns[0]
        ?.workspaceRead?.state,
    ).toBe('running');
    expect(
      toThreadViewModel({ ...activeSnapshot, phase: 'stopping' }).turns[0]
        ?.workspaceRead?.state,
    ).toBe('stopping');
    expect(
      toThreadViewModel({ ...activeSnapshot, phase: 'unavailable' }).turns[0]
        ?.workspaceRead?.state,
    ).toBe('uncertain');
    expect(
      toThreadViewModel({
        revision: 11,
        phase: 'ready',
        threadId: 'thr_0000000000000001',
        turns: [
          {
            ...activeSnapshot.turns[0],
            status: 'interrupted',
          },
        ],
      }).turns[0]?.workspaceRead?.state,
    ).toBe('interrupted');
    const failed = toThreadViewModel({
      revision: 12,
      phase: 'ready',
      threadId: 'thr_0000000000000001',
      turns: [
        {
          id: 'turn_0000000000000006',
          status: 'completed',
          messages: [],
          workspaceRead: {
            id: 'item_0000000000000010',
            callId: 'call_failed',
            path: 'missing.txt',
            callStatus: 'completed',
            result: {
              id: 'item_0000000000000011',
              status: 'completed',
              outcome: { type: 'error', kind: 'notFound' },
            },
          },
        },
      ],
    }).turns[0]?.workspaceRead;
    expect(failed).toMatchObject({
      state: 'failed',
      errorKind: 'notFound',
    });
  });

  it('presents only a workspace list path and durable entry count', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const longPath = `${'nested/'.repeat(20)}directory`;
    const store = createStore({
      thread: toThreadViewModel({
        revision: 13,
        phase: 'ready',
        threadId: 'thr_0000000000000001',
        turns: [
          {
            id: 'turn_0000000000000007',
            status: 'completed',
            messages: [],
            workspaceList: {
              id: 'item_0000000000000012',
              callId: 'call_list',
              path: longPath,
              callStatus: 'completed',
              result: {
                id: 'item_0000000000000013',
                status: 'completed',
                outcome: { type: 'success', entries: 0 },
              },
            },
          },
        ],
      }),
    });

    await act(async () => {
      root.render(<ThreadWorkbenchView store={store} />);
    });

    const activity = document.querySelector(
      `[aria-label="Workspace list complete: ${longPath}"]`,
    );
    expect(activity?.getAttribute('role')).toBe('status');
    expect(activity?.getAttribute('data-state')).toBe('succeeded');
    expect(activity?.textContent).toContain('workspace/list');
    expect(activity?.textContent).toContain(longPath);
    expect(activity?.textContent).toContain('0 entries found');
    expect(activity?.querySelector('code')?.className).toContain('break-all');
    expect(activity?.querySelector('button, a')).toBeNull();
    expect(activity?.textContent).not.toContain('call_list');

    await act(async () => root.unmount());
  });

  it('derives honest workspace list states from lifecycle truth', () => {
    const activeSnapshot = {
      revision: 14,
      threadId: 'thr_0000000000000001',
      activeTurnId: 'turn_0000000000000008',
      turns: [
        {
          id: 'turn_0000000000000008',
          status: 'inProgress' as const,
          messages: [] as const,
          workspaceList: {
            id: 'item_0000000000000014',
            callId: 'call_pending_list',
            path: '.',
            callStatus: 'completed' as const,
          },
        },
      ],
    };

    expect(
      toThreadViewModel({ ...activeSnapshot, phase: 'inProgress' }).turns[0]
        ?.workspaceList?.state,
    ).toBe('running');
    expect(
      toThreadViewModel({ ...activeSnapshot, phase: 'stopping' }).turns[0]
        ?.workspaceList?.state,
    ).toBe('stopping');
    expect(
      toThreadViewModel({ ...activeSnapshot, phase: 'unavailable' }).turns[0]
        ?.workspaceList?.state,
    ).toBe('uncertain');
    expect(
      toThreadViewModel({
        revision: 15,
        phase: 'ready',
        threadId: 'thr_0000000000000001',
        turns: [{ ...activeSnapshot.turns[0], status: 'interrupted' }],
      }).turns[0]?.workspaceList?.state,
    ).toBe('interrupted');
    expect(
      toThreadViewModel({
        revision: 16,
        phase: 'ready',
        threadId: 'thr_0000000000000001',
        turns: [
          {
            id: 'turn_0000000000000009',
            status: 'completed',
            messages: [],
            workspaceList: {
              id: 'item_0000000000000015',
              callId: 'call_failed_list',
              path: 'missing',
              callStatus: 'completed',
              result: {
                id: 'item_0000000000000016',
                status: 'completed',
                outcome: { type: 'error', kind: 'notFound' },
              },
            },
          },
        ],
      }).turns[0]?.workspaceList,
    ).toMatchObject({ state: 'failed', errorKind: 'notFound' });
  });

  it('presents a bounded workspace search summary without match locations', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const longPath = `${'nested/'.repeat(20)}source`;
    const longQuery = 'bounded-search-query-'.repeat(8);
    const store = createStore({
      thread: toThreadViewModel({
        revision: 17,
        phase: 'ready',
        threadId: 'thr_0000000000000001',
        turns: [
          {
            id: 'turn_0000000000000010',
            status: 'completed',
            messages: [],
            workspaceSearch: {
              id: 'item_0000000000000017',
              callId: 'call_search',
              path: longPath,
              query: longQuery,
              callStatus: 'completed',
              result: {
                id: 'item_0000000000000018',
                status: 'completed',
                outcome: {
                  type: 'success',
                  matches: 200,
                  truncated: true,
                },
              },
            },
          },
        ],
      }),
    });

    await act(async () => {
      root.render(<ThreadWorkbenchView store={store} />);
    });

    const activity = document.querySelector(
      `[aria-label="Workspace search complete: ${longPath}"]`,
    );
    expect(activity?.getAttribute('role')).toBe('status');
    expect(activity?.getAttribute('data-state')).toBe('succeeded');
    expect(activity?.textContent).toContain('workspace/search');
    expect(activity?.textContent).toContain(longPath);
    expect(activity?.textContent).toContain(longQuery);
    expect(activity?.textContent).toContain('More than 200 matches found');
    expect(activity?.querySelectorAll('code')).toHaveLength(2);
    expect(activity?.querySelector('button, a')).toBeNull();
    expect(activity?.textContent).not.toContain('call_search');
    expect(activity?.textContent).not.toContain('private.txt');

    await act(async () => root.unmount());
  });

  it('derives honest workspace search states from lifecycle truth', () => {
    const activeSnapshot = {
      revision: 18,
      threadId: 'thr_0000000000000001',
      activeTurnId: 'turn_0000000000000011',
      turns: [
        {
          id: 'turn_0000000000000011',
          status: 'inProgress' as const,
          messages: [] as const,
          workspaceSearch: {
            id: 'item_0000000000000019',
            callId: 'call_pending_search',
            path: 'src',
            query: 'needle',
            callStatus: 'completed' as const,
          },
        },
      ],
    };

    expect(
      toThreadViewModel({ ...activeSnapshot, phase: 'inProgress' }).turns[0]
        ?.workspaceSearch?.state,
    ).toBe('running');
    expect(
      toThreadViewModel({ ...activeSnapshot, phase: 'stopping' }).turns[0]
        ?.workspaceSearch?.state,
    ).toBe('stopping');
    expect(
      toThreadViewModel({ ...activeSnapshot, phase: 'unavailable' }).turns[0]
        ?.workspaceSearch?.state,
    ).toBe('uncertain');
    expect(
      toThreadViewModel({
        revision: 19,
        phase: 'ready',
        threadId: 'thr_0000000000000001',
        turns: [{ ...activeSnapshot.turns[0], status: 'interrupted' }],
      }).turns[0]?.workspaceSearch?.state,
    ).toBe('interrupted');
    expect(
      toThreadViewModel({
        revision: 20,
        phase: 'ready',
        threadId: 'thr_0000000000000001',
        turns: [
          {
            id: 'turn_0000000000000012',
            status: 'completed',
            messages: [],
            workspaceSearch: {
              id: 'item_0000000000000020',
              callId: 'call_failed_search',
              path: 'src',
              query: 'missing',
              callStatus: 'completed',
              result: {
                id: 'item_0000000000000021',
                status: 'completed',
                outcome: { type: 'error', kind: 'notFound' },
              },
            },
          },
        ],
      }).turns[0]?.workspaceSearch,
    ).toMatchObject({ state: 'failed', errorKind: 'notFound' });
  });

  it('presents a durable command result summary without controls, arguments, or output', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const store = createStore({
      thread: toThreadViewModel({
        revision: 21,
        phase: 'ready',
        threadId: 'thr_0000000000000001',
        turns: [
          {
            id: 'turn_0000000000000013',
            status: 'completed',
            messages: [],
            commandApproval: {
              callItemId: 'item_command',
              id: 'item_request',
              callId: 'call_command',
              approvalId: 'approval_command',
              command: '/usr/bin/printf',
              argumentCount: 2,
              requestStatus: 'completed',
              decision: {
                id: 'item_decision',
                status: 'completed',
                value: 'approved',
              },
              executionAttempt: {
                id: 'item_attempt',
                status: 'completed',
              },
              executionResult: {
                id: 'item_result',
                status: 'completed',
                outcome: {
                  type: 'process',
                  stdoutBytes: 22,
                  stderrBytes: 21,
                  stdoutTruncated: false,
                  stderrTruncated: true,
                  encoding: 'utf8Lossy',
                  durationMs: 7,
                  outcome: { type: 'exitCode', code: 0 },
                  sandboxPolicy: 'filesystemReadOnlyV1',
                  networkPolicy: 'networkDeniedV1',
                },
              },
            },
          },
        ],
      }),
    });

    await act(async () => root.render(<ThreadWorkbenchView store={store} />));
    const activity = document.querySelector(
      '[aria-label="Command approved: /usr/bin/printf"]',
    );
    expect(activity?.getAttribute('role')).toBe('status');
    expect(activity?.getAttribute('data-state')).toBe('approved');
    expect(activity?.textContent).toContain('/usr/bin/printf');
    expect(activity?.textContent).toContain('2 arguments');
    expect(activity?.textContent).toContain(
      'Approval recorded; execution audit follows when available',
    );
    const attempt = activity?.querySelector(
      '[aria-label="Execution attempt recorded"]',
    );
    expect(attempt?.getAttribute('data-execution-attempt-state')).toBe(
      'recorded',
    );
    expect(attempt?.textContent).toContain(
      'Executor invocation is durably recorded',
    );
    const result = activity?.querySelector(
      '[aria-label="Execution result recorded: Command exited successfully"]',
    );
    expect(result?.getAttribute('role')).toBe('status');
    expect(result?.getAttribute('data-execution-result-state')).toBe(
      'recorded',
    );
    expect(result?.getAttribute('data-execution-outcome')).toBe('exitCode');
    expect(result?.textContent).toContain('7 ms');
    expect(result?.textContent).toContain('22 B');
    expect(result?.textContent).toContain('21 B · truncated');
    expect(result?.textContent).toContain('utf8Lossy');
    expect(result?.textContent).toContain('filesystemReadOnlyV1');
    expect(result?.textContent).toContain('networkDeniedV1');
    expect(activity?.querySelector('button, a')).toBeNull();
    expect(activity?.textContent).not.toContain('approval_command');
    expect(activity?.textContent).not.toContain('private-value');
    expect(activity?.textContent).not.toContain('item_attempt');
    expect(activity?.textContent).not.toContain('private-command-output');

    await act(async () => root.unmount());
  });

  it.each([
    ['inProgress', 'observed'],
    ['stopping', 'stopping'],
    ['unavailable', 'uncertain'],
  ] as const)(
    'derives command execution result %s state',
    (phase, expected) => {
      expect(
        toThreadViewModel({
          revision: 26,
          phase,
          threadId: 'thr_0000000000000001',
          activeTurnId: 'turn_0000000000000018',
          turns: [
            {
              id: 'turn_0000000000000018',
              status: 'inProgress',
              messages: [],
              commandApproval: {
                callItemId: 'item_command',
                id: 'item_request',
                callId: 'call_command',
                approvalId: 'approval_command',
                command: '/usr/bin/true',
                argumentCount: 0,
                requestStatus: 'completed',
                decision: {
                  id: 'item_decision',
                  status: 'completed',
                  value: 'approved',
                },
                executionAttempt: {
                  id: 'item_attempt',
                  status: 'completed',
                },
                executionResult: {
                  id: 'item_result',
                  status: 'inProgress',
                  outcome: { type: 'error', kind: 'spawnFailed' },
                },
              },
            },
          ],
        }).turns[0]?.commandApproval?.executionResult?.state,
      ).toBe(expected);
    },
  );

  it('keeps a completed execution result recorded across a failed Turn', () => {
    const result = toThreadViewModel({
      revision: 27,
      phase: 'ready',
      threadId: 'thr_0000000000000001',
      turns: [
        {
          id: 'turn_0000000000000019',
          status: 'failed',
          messages: [],
          commandApproval: {
            callItemId: 'item_command',
            id: 'item_request',
            callId: 'call_command',
            approvalId: 'approval_command',
            command: '/usr/bin/false',
            argumentCount: 0,
            requestStatus: 'completed',
            decision: {
              id: 'item_decision',
              status: 'completed',
              value: 'approved',
            },
            executionAttempt: { id: 'item_attempt', status: 'completed' },
            executionResult: {
              id: 'item_result',
              status: 'completed',
              outcome: {
                type: 'process',
                stdoutBytes: 0,
                stderrBytes: 0,
                stdoutTruncated: false,
                stderrTruncated: false,
                encoding: 'utf8Lossy',
                durationMs: 3,
                outcome: { type: 'exitCode', code: 1 },
                sandboxPolicy: 'filesystemReadOnlyV1',
                networkPolicy: 'networkDeniedV1',
              },
            },
          },
          error: { kind: 'server', retryable: false },
        },
      ],
    }).turns[0]?.commandApproval?.executionResult;
    expect(result).toMatchObject({ state: 'recorded' });
  });

  it.each([
    ['inProgress', 'observed'],
    ['stopping', 'stopping'],
    ['unavailable', 'uncertain'],
  ] as const)(
    'derives command execution attempt %s state',
    (phase, expected) => {
      expect(
        toThreadViewModel({
          revision: 25,
          phase,
          threadId: 'thr_0000000000000001',
          activeTurnId: 'turn_0000000000000017',
          turns: [
            {
              id: 'turn_0000000000000017',
              status: 'inProgress',
              messages: [],
              commandApproval: {
                callItemId: 'item_command',
                id: 'item_request',
                callId: 'call_command',
                approvalId: 'approval_command',
                command: '/usr/bin/true',
                argumentCount: 0,
                requestStatus: 'completed',
                decision: {
                  id: 'item_decision',
                  status: 'completed',
                  value: 'approved',
                },
                executionAttempt: {
                  id: 'item_attempt',
                  status: 'inProgress',
                },
              },
            },
          ],
        }).turns[0]?.commandApproval?.executionAttempt?.state,
      ).toBe(expected);
    },
  );

  it.each([
    ['inProgress', 'awaiting'],
    ['stopping', 'stopping'],
    ['unavailable', 'uncertain'],
  ] as const)('derives command approval %s state', (phase, expected) => {
    expect(
      toThreadViewModel({
        revision: 22,
        phase,
        threadId: 'thr_0000000000000001',
        activeTurnId: 'turn_0000000000000014',
        turns: [
          {
            id: 'turn_0000000000000014',
            status: 'inProgress',
            messages: [],
            commandApproval: {
              callItemId: 'item_command',
              id: 'item_request',
              callId: 'call_command',
              approvalId: 'approval_command',
              command: '/usr/bin/true',
              argumentCount: 0,
              requestStatus: 'completed',
            },
          },
        ],
      }).turns[0]?.commandApproval?.state,
    ).toBe(expected);
  });

  it.each([
    'approved',
    'denied',
    'timedOut',
    'unsupported',
    'cancelled',
    'clientDisconnected',
  ] as const)('preserves the exact durable command decision %s', (decision) => {
    expect(
      toThreadViewModel({
        revision: 23,
        phase: 'ready',
        threadId: 'thr_0000000000000001',
        turns: [
          {
            id: 'turn_0000000000000015',
            status: 'completed',
            messages: [],
            commandApproval: {
              callItemId: 'item_command',
              id: 'item_request',
              callId: 'call_command',
              approvalId: 'approval_command',
              command: '/usr/bin/true',
              argumentCount: 0,
              requestStatus: 'completed',
              decision: {
                id: 'item_decision',
                status: 'completed',
                value: decision,
              },
            },
          },
        ],
      }).turns[0]?.commandApproval?.state,
    ).toBe(decision);
  });

  it('shows an interrupted request without inventing a decision', () => {
    expect(
      toThreadViewModel({
        revision: 24,
        phase: 'ready',
        threadId: 'thr_0000000000000001',
        turns: [
          {
            id: 'turn_0000000000000016',
            status: 'interrupted',
            messages: [],
            commandApproval: {
              callItemId: 'item_command',
              id: 'item_request',
              callId: 'call_command',
              approvalId: 'approval_command',
              command: '/usr/bin/true',
              argumentCount: 0,
              requestStatus: 'completed',
            },
          },
        ],
      }).turns[0]?.commandApproval?.state,
    ).toBe('interrupted');
  });
});
