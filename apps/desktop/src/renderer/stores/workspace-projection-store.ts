import { createStore } from 'zustand/vanilla';

import type { WorkspaceStateSnapshot } from '@/shared/workspace';

const INITIAL_SNAPSHOT: WorkspaceStateSnapshot = {
  revision: 0,
  generation: 0,
  status: 'unselected',
};

type WorkspaceProjectionState = Readonly<{
  snapshot: WorkspaceStateSnapshot;
  sourceRevision: number;
  loadError: string | null;
}>;

export const workspaceProjectionStore =
  createStore<WorkspaceProjectionState>()(() => ({
    snapshot: INITIAL_SNAPSHOT,
    sourceRevision: -1,
    loadError: null,
  }));

export const acceptWorkspaceSnapshot = (
  snapshot: WorkspaceStateSnapshot,
): void => {
  if (
    snapshot.revision <=
    workspaceProjectionStore.getState().sourceRevision
  ) {
    return;
  }
  workspaceProjectionStore.setState({
    snapshot,
    sourceRevision: snapshot.revision,
    loadError: snapshot.error ?? null,
  });
};

export const reportWorkspaceProjectionError = (message: string): void => {
  workspaceProjectionStore.setState({ loadError: message });
};
