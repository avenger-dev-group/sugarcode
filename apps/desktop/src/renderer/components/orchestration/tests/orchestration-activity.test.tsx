// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../connection/connection-status', () => ({
  ConnectionStatus: () => <div>Connection</div>,
}));
vi.mock('../../workspace/workbench/workspace-workbench', () => ({
  WorkspaceWorkbench: () => <button type="button">Workspace</button>,
}));
vi.mock('../../workspace/git/git-workbench', () => ({
  GitWorkbench: () => <button type="button">Git</button>,
}));
vi.mock('../../workspace/preview/preview-workbench', () => ({
  PreviewWorkbench: () => <button type="button">Preview</button>,
}));
vi.mock('../../workspace/terminal/terminal-workbench', () => ({
  TerminalWorkbench: () => <button type="button">Terminal</button>,
}));

import { ContextRail } from '../../foundation/context-rail';
import { OrchestrationActivity } from '../orchestration-activity';
import type { OrchestrationActivityViewModel } from '../types';
import { OrchestrationStoreProvider } from '../use-store';

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
HTMLCanvasElement.prototype.getContext = vi.fn(() => null);

const activity: OrchestrationActivityViewModel = {
  id: 'orch/parent/turn',
  tasks: [
    {
      id: 'item-task',
      taskId: 'task-worker',
      clientTaskKey: 'worker',
      childThreadId: 'thr-child',
      title: 'Implement the vertical slice',
      role: 'worker',
      access: 'workspaceWrite',
      dependsOn: [],
      taskMarkdown: '# Objective\nImplement the protocol boundary.',
      status: 'completed',
      amendments: [
        {
          id: 'item-amendment',
          markdown: 'Preserve the user-authored changes.',
        },
      ],
      result: {
        id: 'item-result',
        summaryMarkdown: 'Implementation verified.',
        durationMs: 1_250,
      },
    },
    {
      id: 'item-auditor',
      taskId: 'task-auditor',
      clientTaskKey: 'auditor',
      childThreadId: 'thr-auditor',
      title: 'Audit the implementation',
      role: 'auditor',
      access: 'readOnly',
      dependsOn: ['worker'],
      taskMarkdown: '# Objective\nAudit the result.',
      status: 'running',
      amendments: [],
    },
  ],
};

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('OrchestrationActivity', () => {
  it('opens the Agent rail and renders frozen Markdown, revisions, and result', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onTaskSelected = vi.fn();

    await act(async () => {
      root.render(
        <OrchestrationStoreProvider onTaskSelected={onTaskSelected}>
          <OrchestrationActivity activity={activity} />
          <ContextRail onClose={vi.fn()} />
        </OrchestrationStoreProvider>,
      );
    });

    const worker = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Worker Implement the vertical slice, Completed"]',
    );
    expect(worker).not.toBeNull();
    await act(async () => {
      worker?.click();
    });

    expect(onTaskSelected).toHaveBeenCalledOnce();
    expect(
      document.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toBe('Agent');
    expect(document.body.textContent).toContain(
      'Implement the protocol boundary.',
    );
    expect(document.body.textContent).toContain(
      'Preserve the user-authored changes.',
    );
    expect(document.body.textContent).toContain(
      'Implementation verified.',
    );
    expect(document.body.textContent).toContain('1.3 s');

    await act(async () => {
      root.unmount();
    });
  });
});
