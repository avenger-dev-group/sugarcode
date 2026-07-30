import { describe, expect, it } from 'vitest';

import {
  parseWorkspaceGitCommitResponse,
  parseWorkspaceGitDiffResponse,
  parseWorkspaceGitStatusResponse,
} from '../protocol';

const revision = 'a'.repeat(64);

describe('workspace Git app-server protocol parsing', () => {
  it('accepts exact bounded status and diff responses', () => {
    expect(
      parseWorkspaceGitStatusResponse({
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
      }),
    ).toMatchObject({ status: 'ready', branch: 'main' });

    expect(
      parseWorkspaceGitDiffResponse(
        {
          status: 'ready',
          revision,
          path: 'src/main.rs',
          source: 'worktree',
          content: 'diff --git a/src/main.rs b/src/main.rs\n',
          additions: 1,
          deletions: 0,
        },
        revision,
        'src/main.rs',
        'worktree',
      ),
    ).toMatchObject({ status: 'ready', additions: 1 });
  });

  it('rejects mismatched paths, revisions, and malformed commit receipts', () => {
    expect(() =>
      parseWorkspaceGitDiffResponse(
        {
          status: 'ready',
          revision,
          path: '../secret',
          source: 'worktree',
          content: '',
          additions: 0,
          deletions: 0,
        },
        revision,
        'src/main.rs',
        'worktree',
      ),
    ).toThrow();
    expect(() =>
      parseWorkspaceGitStatusResponse({
        status: 'ready',
        revision,
        repositoryState: 'clean',
        mutationAllowed: true,
        entries: [
          {
            path: 'z.rs',
            worktree: 'modified',
            stageable: true,
          },
          {
            path: 'a.rs',
            worktree: 'modified',
            stageable: true,
          },
        ],
        stagedCount: 0,
        unstagedCount: 2,
        unsupportedPaths: 0,
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceGitCommitResponse({
        status: 'committed',
        revision,
        oldHead: 'b'.repeat(40),
        newHead: 'b'.repeat(40),
      }),
    ).toThrow();
  });
});
