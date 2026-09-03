import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useStore as useZustandStore } from 'zustand';

import {
  closePreview,
  getPreviewState,
  goBackPreview,
  goForwardPreview,
  navigatePreview,
  onPreviewStateChanged,
  openPreview,
  reloadPreview,
  setPreviewBounds,
} from '@/renderer/services/preview';
import { workspaceProjectionStore } from '@/renderer/stores/workspace-projection-store';
import type {
  PreviewActionResult,
  PreviewBounds,
  PreviewSessionRequest,
} from '@/shared/preview';

import type { PreviewWorkbenchState, PreviewWorkbenchStore } from './types';

const INITIAL_PREVIEW_STATE: PreviewWorkbenchState = {
  status: 'closed',
};

const samePreviewState = (
  current: PreviewWorkbenchState,
  next: PreviewWorkbenchState,
): boolean => {
  if (current.status !== next.status) {
    return false;
  }
  if (current.status === 'closed' || next.status === 'closed') {
    return true;
  }
  if (
    current.previewId !== next.previewId ||
    current.generation !== next.generation ||
    current.url !== next.url ||
    current.origin !== next.origin
  ) {
    return false;
  }
  if (current.status === 'failed' || next.status === 'failed') {
    return current.status === 'failed' &&
      next.status === 'failed' &&
      current.error === next.error;
  }
  if (current.sessionId !== next.sessionId) {
    return false;
  }
  if (current.status === 'video' || next.status === 'video') {
    return current.status === 'video' && next.status === 'video' && current.path === next.path;
  }
  return current.status === 'opening' ||
    next.status === 'opening' ||
    (current.canGoBack === next.canGoBack &&
      current.canGoForward === next.canGoForward);
};

const updatePreviewState = (
  setState: Dispatch<SetStateAction<PreviewWorkbenchState>>,
  next: PreviewWorkbenchState,
): void => {
  setState((current) => samePreviewState(current, next) ? current : next);
};

const messageForResult = (result: PreviewActionResult): string | null => {
  if (result.accepted || result.reason === 'cancelled') {
    return null;
  }
  switch (result.reason) {
    case 'invalid':
      return '请输入有效的 HTTP 或 HTTPS 地址。HTML 交付物请从聊天中的预览卡片打开。';
    case 'stale':
      return '工作区已经切换，请从当前项目重新打开预览。';
    case 'busy':
      return '请先处理当前确认操作，或等待预览操作完成。';
    case 'unavailable':
      return '当前工作区状态下无法使用浏览器。';
    case 'failed':
      return '无法安全地打开该页面。';
    default:
      return '浏览器操作失败。';
  }
};

export const useStore = (previewId: string): PreviewWorkbenchStore => {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<PreviewWorkbenchState>(
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
          const tab = preview.tabs.find((entry) => entry.previewId === previewId);
          updatePreviewState(setState, tab ?? INITIAL_PREVIEW_STATE);
          if (tab) {
            setUrl(tab.url);
          }
        }
      })
      .catch(() => {
        if (active) {
          setError('无法读取浏览器状态。');
        }
      });
    const unsubscribePreview = onPreviewStateChanged((snapshot) => {
      if (!active) {
        return;
      }
      const tab = snapshot.tabs.find((entry) => entry.previewId === previewId);
      updatePreviewState(setState, tab ?? INITIAL_PREVIEW_STATE);
      if (tab) {
        setUrl(tab.url);
      }
      if (tab?.status === 'failed') {
        setError(
          tab.error === 'policyUnavailable'
            ? '无法启用预览浏览器的安全策略。'
            : tab.error === 'renderProcessGone'
              ? '浏览器渲染进程意外停止。'
              : '页面未能完成加载。',
        );
      }
    });
    return () => {
      active = false;
      unsubscribePreview();
    };
  }, [previewId]);

  const run = async (
    action: () => Promise<PreviewActionResult>,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setError(messageForResult(result));
    } catch {
      setError('浏览器无法连接桌面主进程。');
    } finally {
      setBusy(false);
    }
  };

  const sessionRequest = (): PreviewSessionRequest | null =>
    state.status === 'opening' || state.status === 'ready' || state.status === 'video'
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
      setError('当前没有已打开的页面。');
      return;
    }
    await run(() => action(request));
  };

  return {
    url,
    state,
    workspace,
    busy,
    error,
    setUrl,
    navigate: async () => {
      const value = url.trim();
      const normalizedUrl = /^[a-z][a-z\d+.-]*:\/\//iu.test(value)
        ? value
        : /^(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/iu.test(value)
          ? `http://${value}`
          : `https://${value}`;
      setUrl(normalizedUrl);
      const request = sessionRequest();
      await run(() =>
        request
          ? navigatePreview({ ...request, url: normalizedUrl })
          : openPreview({
              previewId,
              generation: workspace.generation,
              url: normalizedUrl,
            }),
      );
    },
    setBounds: async (bounds: PreviewBounds | null) => {
      const request = sessionRequest();
      if (!request) {
        return;
      }
      try {
        await setPreviewBounds({ ...request, bounds });
      } catch {
        setError('无法定位右侧浏览器画布。');
      }
    },
    reload: () => runSessionAction(reloadPreview),
    goBack: () => runSessionAction(goBackPreview),
    goForward: () => runSessionAction(goForwardPreview),
    close: () => runSessionAction(closePreview),
  };
};
