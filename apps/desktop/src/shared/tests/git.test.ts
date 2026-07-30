import { describe, expect, it } from 'vitest';

import {
  isGitCommitRequest,
  isGitDiffRequest,
  isGitMutationRequest,
  isGitStateSnapshot,
} from '../git';

const revision = 'a'.repeat(64);

describe('Git desktop boundary validation', () => {
  it('accepts workspace-relative revision-bound requests', () => {
    expect(
      isGitDiffRequest({
        generation: 2,
        expectedRevision: revision,
        path: 'src/main.rs',
        source: 'worktree',
      }),
    ).toBe(true);
    expect(
      isGitMutationRequest({
        generation: 2,
        expectedRevision: revision,
        paths: ['src/main.rs'],
      }),
    ).toBe(true);
    expect(
      isGitCommitRequest({
        generation: 2,
        expectedRevision: revision,
        message: 'test: update',
        authorName: 'SugarCode Test',
        authorEmail: 'test@example.invalid',
      }),
    ).toBe(true);
  });

  it('rejects absolute paths, duplicates, and extended authority', () => {
    expect(
      isGitDiffRequest({
        generation: 2,
        expectedRevision: revision,
        path: '/etc/passwd',
        source: 'worktree',
      }),
    ).toBe(false);
    expect(
      isGitMutationRequest({
        generation: 2,
        expectedRevision: revision,
        paths: ['src/main.rs', 'src/main.rs'],
      }),
    ).toBe(false);
    expect(
      isGitMutationRequest({
        generation: 2,
        expectedRevision: revision,
        paths: ['src/main.rs'],
        cwd: '/private/project',
      }),
    ).toBe(false);
  });

  it('validates redacted state without absolute repository metadata', () => {
    const snapshot = {
      revision: 3,
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
    } as const;
    expect(isGitStateSnapshot(snapshot)).toBe(true);
    expect(
      isGitStateSnapshot({
        ...snapshot,
        repository: {
          ...snapshot.repository,
          unstagedCount: -1,
        },
      }),
    ).toBe(false);
    expect(
      isGitStateSnapshot({
        ...snapshot,
        repository: {
          ...snapshot.repository,
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
          unstagedCount: 2,
        },
      }),
    ).toBe(false);
  });
});
