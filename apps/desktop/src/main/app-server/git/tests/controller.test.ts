import type {
  WorkspaceGitStatusResponse,
} from '@sugarcode/app-server-protocol';
import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceStateSnapshot } from '@/shared/workspace';

import { GitController } from '../controller';
import type { ConnectionSupervisor } from '../../connection/supervisor';
import type { WorkspaceController } from '../../workspace/controller';

const revisionA = 'a'.repeat(64);
const revisionB = 'b'.repeat(64);

const status = (
  revision: string,
  staged: boolean,
): Extract<WorkspaceGitStatusResponse, { status: 'ready' }> => ({
  status: 'ready',
  revision,
  branch: 'main',
  head: 'c'.repeat(40),
  repositoryState: 'clean',
  mutationAllowed: true,
  entries: [
    {
      path: 'src/main.rs',
      ...(staged ? { index: 'modified' as const } : {}),
      ...(!staged ? { worktree: 'modified' as const } : {}),
      stageable: true,
    },
  ],
  stagedCount: staged ? 1 : 0,
  unstagedCount: staged ? 0 : 1,
  unsupportedPaths: 0,
});

const fixture = () => {
  let workspace: WorkspaceStateSnapshot = {
    revision: 1,
    generation: 2,
    status: 'ready',
    name: 'project',
  };
  const workspaceListeners = new Set<
    (snapshot: WorkspaceStateSnapshot) => void
  >();
  const workspaceBoundary = {
    getSnapshot: () => workspace,
    subscribe: (listener: (snapshot: WorkspaceStateSnapshot) => void) => {
      workspaceListeners.add(listener);
      return () => workspaceListeners.delete(listener);
    },
  } as unknown as WorkspaceController;
  const supervisor = {
    beginGitTransaction: vi.fn(() => ({ release: vi.fn() })),
    gitStatus: vi.fn(async () => status(revisionA, false)),
    gitStage: vi.fn(async () => ({
      status: 'applied' as const,
      revision: revisionB,
      paths: ['src/main.rs'],
    })),
    gitUnstage: vi.fn(),
    gitDiff: vi.fn(),
    gitCommit: vi.fn(),
  } as unknown as ConnectionSupervisor;
  return {
    controller: new GitController({
      supervisor,
      workspace: workspaceBoundary,
    }),
    supervisor,
    switchWorkspace: (next: WorkspaceStateSnapshot) => {
      workspace = next;
      for (const listener of workspaceListeners) {
        listener(next);
      }
    },
  };
};

describe('GitController', () => {
  it('refreshes, validates known paths, and reconciles stage receipts', async () => {
    const { controller, supervisor } = fixture();
    const refreshed = await controller.refresh({ generation: 2 });
    expect(refreshed.accepted).toBe(true);

    expect(
      await controller.stage({
        generation: 2,
        expectedRevision: revisionA,
        paths: ['unknown.txt'],
      }),
    ).toEqual({ accepted: false, reason: 'invalid' });

    vi.mocked(supervisor.gitStatus).mockResolvedValueOnce(
      status(revisionB, true),
    );
    const staged = await controller.stage({
      generation: 2,
      expectedRevision: revisionA,
      paths: ['src/main.rs'],
    });
    expect(staged).toMatchObject({
      accepted: true,
      receipt: { status: 'applied', revision: revisionB },
      state: {
        repository: { status: 'ready', revision: revisionB },
      },
    });
  });

  it('invalidates authority on workspace generation change', async () => {
    const { controller, switchWorkspace } = fixture();
    await controller.refresh({ generation: 2 });
    switchWorkspace({
      revision: 2,
      generation: 3,
      status: 'ready',
      name: 'other',
    });
    expect(controller.getSnapshot()).toMatchObject({
      generation: 3,
      status: 'idle',
    });
    expect(controller.getSnapshot().repository).toBeUndefined();
    expect(
      await controller.refresh({ generation: 2 }),
    ).toEqual({ accepted: false, reason: 'stale' });
  });
});
