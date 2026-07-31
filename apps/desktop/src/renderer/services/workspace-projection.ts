import {
  acceptWorkspaceSnapshot,
  reportWorkspaceProjectionError,
} from '@/renderer/stores/workspace-projection-store';

import {
  getWorkspaceState,
  onWorkspaceStateChanged,
} from './workspace';

let stopActiveProjection: (() => void) | null = null;

export const stopWorkspaceProjection = (): void => {
  stopActiveProjection?.();
};

export const startWorkspaceProjection = (): (() => void) => {
  if (stopActiveProjection) {
    return stopWorkspaceProjection;
  }

  let active = true;
  const unsubscribe = onWorkspaceStateChanged((snapshot) => {
    if (active) {
      acceptWorkspaceSnapshot(snapshot);
    }
  });
  stopActiveProjection = () => {
    if (!active) {
      return;
    }
    active = false;
    unsubscribe();
    stopActiveProjection = null;
  };

  void getWorkspaceState()
    .then((snapshot) => {
      if (active) {
        acceptWorkspaceSnapshot(snapshot);
      }
    })
    .catch(() => {
      if (active) {
        reportWorkspaceProjectionError(
          'Workspace state is unavailable.',
        );
      }
    });

  return stopWorkspaceProjection;
};
