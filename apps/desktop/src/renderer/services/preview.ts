import type {
  PreviewActionResult,
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

export const showPreview = (
  request: PreviewSessionRequest,
): Promise<PreviewActionResult> => window.sugarcode.showPreview(request);

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
