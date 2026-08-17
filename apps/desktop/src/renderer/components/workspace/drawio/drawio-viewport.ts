export const DRAWIO_MIN_SCALE = 0.2;
export const DRAWIO_MAX_SCALE = 4;
export const DRAWIO_MAX_FIT_SCALE = 1.25;
export const DRAWIO_FIT_MARGIN = 32;

export const clampDrawioScale = (scale: number): number =>
  Number.isFinite(scale)
    ? Math.min(DRAWIO_MAX_SCALE, Math.max(DRAWIO_MIN_SCALE, scale))
    : 1;

export const resolveDrawioFitScale = ({
  containerHeight,
  containerWidth,
  graphHeight,
  graphWidth,
  margin = DRAWIO_FIT_MARGIN,
}: Readonly<{
  containerHeight: number;
  containerWidth: number;
  graphHeight: number;
  graphWidth: number;
  margin?: number;
}>): number | null => {
  if (
    ![containerHeight, containerWidth, graphHeight, graphWidth, margin].every(
      Number.isFinite,
    ) ||
    margin < 0
  ) {
    return null;
  }
  const availableWidth = containerWidth - margin * 2;
  const availableHeight = containerHeight - margin * 2;
  if (
    availableWidth <= 0 ||
    availableHeight <= 0 ||
    graphWidth <= 0 ||
    graphHeight <= 0
  ) {
    return null;
  }
  return Math.min(
    DRAWIO_MAX_FIT_SCALE,
    Math.max(
      DRAWIO_MIN_SCALE,
      Math.min(availableWidth / graphWidth, availableHeight / graphHeight),
    ),
  );
};
