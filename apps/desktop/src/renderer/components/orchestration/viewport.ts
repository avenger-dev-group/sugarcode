import { getViewportForBounds } from '@xyflow/react';

type GraphBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

type VisibleGraphViewportOptions = Readonly<{
  bounds: GraphBounds;
  containerWidth: number;
  containerHeight: number;
  visibleLeft: number;
  visibleRight: number;
  minZoom: number;
  maxZoom: number;
  padding: number;
}>;

export type GraphViewport = Readonly<{
  x: number;
  y: number;
  zoom: number;
}>;

export const calculateVisibleGraphViewport = ({
  bounds,
  containerWidth,
  containerHeight,
  visibleLeft,
  visibleRight,
  minZoom,
  maxZoom,
  padding,
}: VisibleGraphViewportOptions): GraphViewport | null => {
  const left = Math.max(0, Math.min(containerWidth, visibleLeft));
  const right = Math.max(left, Math.min(containerWidth, visibleRight));
  const visibleWidth = right - left;
  if (
    visibleWidth <= 0 ||
    containerHeight <= 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return null;
  }

  const viewport = getViewportForBounds(
    bounds,
    visibleWidth,
    containerHeight,
    minZoom,
    maxZoom,
    padding,
  );
  return {
    ...viewport,
    x: viewport.x + left,
  };
};
