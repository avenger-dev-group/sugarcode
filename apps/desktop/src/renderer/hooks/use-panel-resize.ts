import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { PanelResizeHandle } from '@/renderer/components/foundation/types';

type UsePanelResizeOptions = Readonly<{
  width: number;
  minWidth: number;
  maxWidth: number;
  reverse?: boolean;
  onResize: (width: number) => void;
}>;

const bounded = (value: number, minWidth: number, maxWidth: number): number =>
  Math.min(maxWidth, Math.max(minWidth, value));

export const usePanelResize = ({
  width,
  minWidth,
  maxWidth,
  reverse = false,
  onResize,
}: UsePanelResizeOptions): PanelResizeHandle => {
  const [dragging, setDragging] = useState<boolean>(false);
  const startX = useRef<number>(0);
  const startWidth = useRef<number>(width);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    startX.current = event.clientX;
    startWidth.current = width;
    setDragging(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const delta = (reverse ? -direction : direction) * (event.shiftKey ? 32 : 8);
    onResizeRef.current(bounded(width + delta, minWidth, maxWidth));
  };

  useEffect(() => {
    if (!dragging) {
      return;
    }

    let animationFrame: number | null = null;
    let pendingWidth: number | null = null;
    const flushResize = (): void => {
      animationFrame = null;
      if (pendingWidth === null) {
        return;
      }
      onResizeRef.current(pendingWidth);
      pendingWidth = null;
    };
    const handlePointerMove = (event: globalThis.PointerEvent): void => {
      const rawDelta = event.clientX - startX.current;
      const delta = reverse ? -rawDelta : rawDelta;
      pendingWidth = bounded(startWidth.current + delta, minWidth, maxWidth);
      if (animationFrame === null) {
        animationFrame = requestAnimationFrame(flushResize);
      }
    };
    const handlePointerUp = (): void => {
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
      }
      flushResize();
      setDragging(false);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);
    document.body.classList.add('is-resizing-panel');
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
      document.body.classList.remove('is-resizing-panel');
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
      }
    };
  }, [dragging, maxWidth, minWidth, reverse]);

  return {
    dragging,
    maxWidth,
    minWidth,
    onKeyDown,
    onPointerDown,
    width,
  };
};
