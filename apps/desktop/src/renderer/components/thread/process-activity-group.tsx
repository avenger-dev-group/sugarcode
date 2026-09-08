import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type UIEvent,
  type WheelEvent,
} from 'react';

import type { ProcessActivityGroupProps } from './types';
import {
  shouldFollowProcessAfterScroll,
  shouldHandoffWheelScroll,
  shouldUseProcessScrollViewport,
} from './transcript-follow';

const handoffWheelAtProcessBoundary = (
  event: WheelEvent<HTMLDivElement>,
): void => {
  const processViewport = event.currentTarget;
  if (
    !shouldHandoffWheelScroll({
      deltaY: event.deltaY,
      scrollTop: processViewport.scrollTop,
      scrollHeight: processViewport.scrollHeight,
      clientHeight: processViewport.clientHeight,
    })
  ) {
    return;
  }
  const transcriptViewport = processViewport.closest<HTMLElement>(
    '[data-slot="scroll-area-viewport"][aria-label="Conversation transcript"]',
  );
  if (!transcriptViewport) {
    return;
  }
  transcriptViewport.scrollTop += event.deltaY;
};

export const ProcessActivityGroup = ({
  status,
  requiresAttention,
  language,
  activeLabel,
  children,
}: ProcessActivityGroupProps) => {
  const active = shouldUseProcessScrollViewport({ status, requiresAttention });
  const processViewport = useRef<HTMLDivElement | null>(null);
  const processContent = useRef<HTMLDivElement | null>(null);
  const shouldFollowProcess = useRef(true);
  const scrollProcessToEnd = useCallback((): void => {
    if (!active || !shouldFollowProcess.current) {
      return;
    }
    const viewport = processViewport.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [active]);
  const recordProcessScroll = (event: UIEvent<HTMLDivElement>): void => {
    const viewport = event.currentTarget;
    shouldFollowProcess.current = shouldFollowProcessAfterScroll({
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
    });
  };
  const recordProcessWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (event.deltaY < 0) {
      shouldFollowProcess.current = false;
    }
    handoffWheelAtProcessBoundary(event);
  };

  useLayoutEffect(() => {
    if (!active) {
      return undefined;
    }
    shouldFollowProcess.current = true;
    scrollProcessToEnd();
    const animationFrame = requestAnimationFrame(scrollProcessToEnd);
    return () => cancelAnimationFrame(animationFrame);
  }, [active, scrollProcessToEnd]);

  useEffect(() => {
    const content = processContent.current;
    if (!content) {
      return undefined;
    }
    const observer = new ResizeObserver(scrollProcessToEnd);
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollProcessToEnd]);

  return (
    <div className="block w-full min-w-0">
      {active && activeLabel ? (
        <span className="sr-only" role="status" aria-live="polite">
          {activeLabel}
        </span>
      ) : null}
      <div
        ref={processViewport}
        className={`w-full min-w-0 border-b border-border/60 pb-2.5 pr-2 ${
          active
            ? 'max-h-[min(55vh,36rem)] overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]'
            : 'overflow-visible'
        }`}
        onScroll={active ? recordProcessScroll : undefined}
        onWheel={active ? recordProcessWheel : undefined}
        tabIndex={active ? 0 : undefined}
        role="region"
        aria-label={language === 'zh' ? '处理过程' : 'Process activity'}
      >
        <div ref={processContent} className="space-y-1.5">
          {children}
        </div>
      </div>
    </div>
  );
};
