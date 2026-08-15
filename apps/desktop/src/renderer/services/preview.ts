import type {
  PreviewActionResult,
  PreviewBoundsRequest,
  PreviewNavigateRequest,
  PreviewOpenRequest,
  PreviewSessionRequest,
  PreviewStateSnapshot,
} from '@/shared/preview';

export const getPreviewState = (): Promise<PreviewStateSnapshot> =>
  window.sugarcode.getPreviewState();

export const onPreviewStateChanged = (
  listener: (snapshot: PreviewStateSnapshot) => void,
): (() => void) => window.sugarcode.onPreviewStateChanged(listener);

export const openPreview = (
  request: PreviewOpenRequest,
): Promise<PreviewActionResult> => window.sugarcode.openPreview(request);

export const openExternalPreview = (
  request: PreviewOpenRequest,
): Promise<PreviewActionResult> => window.sugarcode.openExternalPreview(request);

export const setPreviewBounds = (
  request: PreviewBoundsRequest,
): Promise<PreviewActionResult> => window.sugarcode.setPreviewBounds(request);

export const navigatePreview = (
  request: PreviewNavigateRequest,
): Promise<PreviewActionResult> => window.sugarcode.navigatePreview(request);

export const reloadPreview = (
  request: PreviewSessionRequest,
): Promise<PreviewActionResult> => window.sugarcode.reloadPreview(request);

export const goBackPreview = (
  request: PreviewSessionRequest,
): Promise<PreviewActionResult> => window.sugarcode.goBackPreview(request);

export const goForwardPreview = (
  request: PreviewSessionRequest,
): Promise<PreviewActionResult> =>
  window.sugarcode.goForwardPreview(request);

export const closePreview = (
  request: PreviewSessionRequest,
): Promise<PreviewActionResult> => window.sugarcode.closePreview(request);
