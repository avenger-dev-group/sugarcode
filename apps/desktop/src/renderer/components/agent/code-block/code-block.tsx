import { Check, Copy, TriangleAlert } from 'lucide-react';
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from '@/renderer/components/ui/button';
import { highlightCode } from '@/renderer/utils/syntax-highlighter';

import type { AgentCodeBlockProps, CodeBlockCopyState } from './types';
import { useStore } from './use-store';

const CODE_LANGUAGE_HINT_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_+.#-]{0,63}$/u;

const codeLanguageHint = (language: string | undefined): string | null => {
  const hint = language?.trimStart().split(/\s+/u, 1)[0];
  return hint && CODE_LANGUAGE_HINT_PATTERN.test(hint) ? hint : null;
};

const codeLineCount = (code: string): number => {
  if (code.length === 0) {
    return 0;
  }
  return code.split('\n').length;
};

const codeLineLabel = (lines: number): string =>
  `${lines} ${lines === 1 ? 'line' : 'lines'}`;

const copyLabel = (state: CodeBlockCopyState): string => {
  switch (state) {
    case 'copied':
      return 'Copied';
    case 'failed':
      return 'Copy failed';
    default:
      return 'Copy';
  }
};

const copyAriaLabel = (state: CodeBlockCopyState): string => {
  switch (state) {
    case 'copied':
      return 'Code copied';
    case 'failed':
      return 'Copy failed. Try again';
    default:
      return 'Copy code';
  }
};

type CodeScrollState = Readonly<{
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
}>;

const INITIAL_SCROLL_STATE: CodeScrollState = {
  clientWidth: 0,
  scrollLeft: 0,
  scrollWidth: 0,
};

export const AgentCodeBlock = ({
  code,
  language,
}: AgentCodeBlockProps): ReactElement => {
  const scrollViewportId = useId();
  const scrollViewportRef = useRef<HTMLPreElement>(null);
  const scrollTrackRef = useRef<HTMLDivElement>(null);
  const scrollThumbRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    grabOffset: number;
  } | null>(null);
  const [scrollState, setScrollState] =
    useState<CodeScrollState>(INITIAL_SCROLL_STATE);
  const languageHint = codeLanguageHint(language);
  const highlightedCode = useMemo(
    () => highlightCode(code, languageHint ?? undefined),
    [code, languageHint],
  );
  const { copy, copyState } = useStore(code);
  const lineLabel = codeLineLabel(codeLineCount(code));
  const label = copyLabel(copyState);
  const captionLabel = languageHint
    ? `${languageHint} code, ${lineLabel}`
    : `Code block, ${lineLabel}`;
  const maxScrollLeft = Math.max(
    0,
    scrollState.scrollWidth - scrollState.clientWidth,
  );
  const thumbWidthRatio =
    scrollState.scrollWidth > 0
      ? Math.min(1, scrollState.clientWidth / scrollState.scrollWidth)
      : 1;
  const scrollProgress =
    maxScrollLeft > 0
      ? scrollState.scrollLeft / maxScrollLeft
      : 0;

  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const sync = (): void => {
      const next = {
        clientWidth: viewport.clientWidth,
        scrollLeft: viewport.scrollLeft,
        scrollWidth: viewport.scrollWidth,
      };
      setScrollState((current) =>
        current.clientWidth === next.clientWidth &&
        current.scrollLeft === next.scrollLeft &&
        current.scrollWidth === next.scrollWidth
          ? current
          : next,
      );
    };

    sync();
    viewport.addEventListener('scroll', sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    return () => {
      viewport.removeEventListener('scroll', sync);
      observer.disconnect();
    };
  }, [code]);

  const scrollFromPointer = (clientX: number, grabOffset: number): void => {
    const viewport = scrollViewportRef.current;
    const track = scrollTrackRef.current;
    const thumb = scrollThumbRef.current;
    if (!viewport || !track || !thumb || maxScrollLeft <= 0) return;

    const trackBounds = track.getBoundingClientRect();
    const thumbWidth = thumb.getBoundingClientRect().width;
    const travel = trackBounds.width - thumbWidth;
    if (travel <= 0) return;
    const thumbLeft = Math.min(
      travel,
      Math.max(0, clientX - trackBounds.left - grabOffset),
    );
    viewport.scrollLeft = (thumbLeft / travel) * maxScrollLeft;
  };

  const beginScrollDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const track = scrollTrackRef.current;
    const thumb = scrollThumbRef.current;
    if (!track || !thumb) return;

    const thumbBounds = thumb.getBoundingClientRect();
    const startedOnThumb = thumb.contains(event.target as Node);
    const grabOffset = startedOnThumb
      ? event.clientX - thumbBounds.left
      : thumbBounds.width / 2;
    dragRef.current = { pointerId: event.pointerId, grabOffset };
    event.currentTarget.setPointerCapture(event.pointerId);
    scrollFromPointer(event.clientX, grabOffset);
  };

  const continueScrollDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    scrollFromPointer(event.clientX, drag.grabOffset);
  };

  const endScrollDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleScrollKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const viewport = scrollViewportRef.current;
    if (!viewport || maxScrollLeft <= 0) return;

    const step = 48;
    const page = Math.max(step, viewport.clientWidth * 0.8);
    const next =
      event.key === 'ArrowLeft'
        ? viewport.scrollLeft - step
        : event.key === 'ArrowRight'
          ? viewport.scrollLeft + step
          : event.key === 'PageUp'
            ? viewport.scrollLeft - page
            : event.key === 'PageDown'
              ? viewport.scrollLeft + page
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? maxScrollLeft
                  : null;
    if (next === null) return;
    event.preventDefault();
    viewport.scrollLeft = Math.min(maxScrollLeft, Math.max(0, next));
  };

  return (
    <figure
      aria-label={captionLabel}
      className="agent-code-block syntax-highlight my-3.5 min-w-0 max-w-full overflow-hidden rounded-lg border bg-surface first:mt-0 last:mb-0"
    >
      <figcaption className="flex min-w-0 items-center gap-3 border-b px-2 py-1 font-mono text-[10px] text-tertiary">
        <span className="min-w-0 break-all px-1 uppercase tracking-[0.12em]">
          {languageHint ?? 'Code'}
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap tracking-[0.08em]">
          {lineLabel}
        </span>
        <Button
          aria-label={copyAriaLabel(copyState)}
          className="h-6 px-1.5 font-mono text-[10px] text-tertiary hover:bg-surface-hover hover:text-foreground"
          onClick={() => {
            void copy();
          }}
          size="xs"
          title={copyState === 'failed' ? 'Copy failed. Try again' : label}
          type="button"
          variant="ghost"
        >
          {copyState === 'copied' ? (
            <Check aria-hidden="true" />
          ) : copyState === 'failed' ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          <span aria-live="polite">{label}</span>
        </Button>
      </figcaption>
      <pre
        id={scrollViewportId}
        ref={scrollViewportRef}
        className="agent-code-scrollbar max-w-full overflow-x-auto p-3 font-mono text-xs font-normal leading-5"
      >
        {highlightedCode === null ? (
          <code>{code}</code>
        ) : (
          <code
            className="hljs"
            dangerouslySetInnerHTML={{ __html: highlightedCode }}
          />
        )}
      </pre>
      {maxScrollLeft > 1 ? (
        <div
          ref={scrollTrackRef}
          role="scrollbar"
          aria-controls={scrollViewportId}
          aria-label="水平滚动代码"
          aria-orientation="horizontal"
          aria-valuemax={Math.ceil(maxScrollLeft)}
          aria-valuemin={0}
          aria-valuenow={Math.round(scrollState.scrollLeft)}
          className="agent-code-scroll-track"
          tabIndex={0}
          onKeyDown={handleScrollKey}
          onPointerCancel={endScrollDrag}
          onPointerDown={beginScrollDrag}
          onPointerMove={continueScrollDrag}
          onPointerUp={endScrollDrag}
        >
          <div
            ref={scrollThumbRef}
            className="agent-code-scroll-thumb"
            style={{
              left: `${scrollProgress * 100}%`,
              transform: `translateX(-${scrollProgress * 100}%)`,
              width: `${thumbWidthRatio * 100}%`,
            }}
          />
        </div>
      ) : null}
    </figure>
  );
};
