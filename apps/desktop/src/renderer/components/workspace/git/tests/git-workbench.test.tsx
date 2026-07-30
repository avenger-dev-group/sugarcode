// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '@/shared/desktop-api';
import type { GitStateSnapshot } from '@/shared/git';

import { GitWorkbench } from '../git-workbench';

const revision = 'a'.repeat(64);
const state: GitStateSnapshot = {
  revision: 1,
  generation: 2,
  status: 'ready',
  repository: {
    status: 'ready',
    revision,
    branch: 'main',
    head: 'b'.repeat(40),
    repositoryState: 'clean',
    mutationAllowed: true,
    entries: [
      {
        path: 'src/main.rs',
        worktree: 'modified',
        stageable: true,
      },
    ],
    stagedCount: 0,
    unstagedCount: 1,
    unsupportedPaths: 0,
  },
};

describe('GitWorkbench', () => {
  it('renders repository status and loads an independently labelled diff', async () => {
    const loadGitDiff = vi.fn(async () => ({
      accepted: true as const,
      generation: 2,
      diff: {
        status: 'ready' as const,
        revision,
        path: 'src/main.rs',
        source: 'worktree' as const,
        content:
          'diff --git a/src/main.rs b/src/main.rs\n@@ -1,1 +1,1 @@\n-old\n+new\n',
        additions: 1,
        deletions: 1,
      },
    }));
    Object.defineProperty(window, 'sugarcode', {
      configurable: true,
      value: {
        getGitState: vi.fn(async () => state),
        onGitStateChanged: vi.fn(
          (): (() => void) => () => undefined,
        ),
        refreshGitStatus: vi.fn(async () => ({
          accepted: true as const,
          state,
        })),
        loadGitDiff,
        stageGitPaths: vi.fn(),
        unstageGitPaths: vi.fn(),
        commitGitIndex: vi.fn(),
      } as unknown as DesktopApi,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<GitWorkbench />));
    await act(async () => Promise.resolve());

    await act(async () => {
      (
        container.querySelector(
          'button[title="Git changes"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(container.textContent).toContain('main');
    expect(container.textContent).toContain('src/main.rs');
    expect(container.textContent).toContain('Working · Modified');

    await act(async () => {
      (
        [...container.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('Working · Modified'),
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => Promise.resolve());
    expect(loadGitDiff).toHaveBeenCalledWith({
      generation: 2,
      expectedRevision: revision,
      path: 'src/main.rs',
      source: 'worktree',
    });
    expect(container.textContent).toContain('-old');
    expect(container.textContent).toContain('+new');
    expect(
      container.querySelector(
        '[aria-label="Git diff for src/main.rs"]',
      ),
    ).not.toBeNull();
    await act(async () => root.unmount());
  });
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

afterEach(() => document.body.replaceChildren());
