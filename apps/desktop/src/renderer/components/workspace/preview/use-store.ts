import { useEffect, useState } from 'react';
import { useStore as useZustandStore } from 'zustand';

import {
  closePreview,
  getPreviewState,
  goBackPreview,
  goForwardPreview,
  onPreviewStateChanged,
  openPreview,
  reloadPreview,
  showPreview,
} from '@/renderer/services/preview';
import { workspaceProjectionStore } from '@/renderer/stores/workspace-projection-store';
import type {
  PreviewActionResult,
  PreviewSessionRequest,
  PreviewStateSnapshot,
} from '@/shared/preview';

import type { PreviewWorkbenchStore } from './types';

const INITIAL_PREVIEW_STATE: PreviewStateSnapshot = {
  revision: 0,
  status: 'closed',
};
const messageForResult = (result: PreviewActionResult): string | null => {
  if (result.accepted || result.reason === 'cancelled') {
    return null;
  }
  switch (result.reason) {
    case 'invalid':
      return 'Use an HTTP URL with an explicit port on 127.0.0.1 or ::1.';
    case 'stale':
      return 'The workspace changed. Reopen the preview from the current workspace.';
    case 'busy':
      return 'Resolve the active approval or preview operation first.';
    case 'unavailable':
      return 'The local preview is not available in the current workspace state.';
    case 'failed':
      return 'The local preview could not be opened safely.';
    default:
      return 'The local preview action failed.';
  }
};

export const useStore = (): PreviewWorkbenchStore => {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('http://127.0.0.1:3000/');
  const [state, setState] = useState<PreviewStateSnapshot>(
    INITIAL_PREVIEW_STATE,
  );
  const workspace = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.snapshot,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getPreviewState()
      .then((preview) => {
        if (active) {
          setState(preview);
        }
      })
      .catch(() => {
        if (active) {
          setError('Local preview state is unavailable.');
        }
      });
    const unsubscribePreview = onPreviewStateChanged((snapshot) => {
      if (!active) {
        return;
      }
      setState(snapshot);
      if (snapshot.status === 'failed') {
        setError(
          snapshot.error === 'policyUnavailable'
            ? 'The browser safety policy could not be installed.'
            : snapshot.error === 'renderProcessGone'
              ? 'The local preview process stopped unexpectedly.'
              : 'The local server did not finish loading.',
        );
      }
    });
    return () => {
      active = false;
      unsubscribePreview();
    };
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const run = async (
    action: () => Promise<PreviewActionResult>,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setError(messageForResult(result));
    } catch {
      setError('The local preview action could not reach Desktop Main.');
    } finally {
      setBusy(false);
    }
  };

  const sessionRequest = (): PreviewSessionRequest | null =>
    state.status === 'opening' || state.status === 'ready'
      ? {
          generation: state.generation,
          sessionId: state.sessionId,
        }
      : null;

  const runSessionAction = async (
    action: (request: PreviewSessionRequest) => Promise<PreviewActionResult>,
  ): Promise<void> => {
    const request = sessionRequest();
    if (!request) {
      setError('There is no active local preview.');
      return;
    }
    await run(() => action(request));
  };

  return {
    open,
    url,
    state,
    workspace,
    busy,
    error,
    setOpen,
    setUrl,
    openLocalPreview: async () => {
      await run(() =>
        openPreview({
          generation: workspace.generation,
          url,
        }),
      );
    },
    show: () => runSessionAction(showPreview),
    reload: () => runSessionAction(reloadPreview),
    goBack: () => runSessionAction(goBackPreview),
    goForward: () => runSessionAction(goForwardPreview),
    close: () => runSessionAction(closePreview),
  };
};
