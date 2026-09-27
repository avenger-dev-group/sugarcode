import { useEffect, useMemo, useState, type RefObject } from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/renderer/components/ui/tooltip';

import type { TurnViewModel } from './types';
import {
  shouldShowTurnNavigator,
  toTurnNavigationPreview,
} from './turn-navigation';

type ConversationTurnNavigatorProps = Readonly<{
  turns: readonly TurnViewModel[];
  viewportRef: RefObject<HTMLDivElement | null>;
}>;

const getTurnElements = (viewport: HTMLDivElement): HTMLElement[] =>
  Array.from(
    viewport.querySelectorAll<HTMLElement>('[data-conversation-turn-id]'),
  );

export const ConversationTurnNavigator = ({
  turns,
  viewportRef,
}: ConversationTurnNavigatorProps) => {
  const [activeTurnId, setActiveTurnId] = useState<string | null>(
    turns[0]?.id ?? null,
  );
  const previews = useMemo(
    () =>
      new Map(
        turns.map((turn, index) => [
          turn.id,
          toTurnNavigationPreview(turn, index + 1),
        ]),
      ),
    [turns],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !shouldShowTurnNavigator(turns.length)) {
      return;
    }
    let frame = 0;
    const updateActiveTurn = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const elements = getTurnElements(viewport);
        if (elements.length === 0) {
          return;
        }
        const viewportRect = viewport.getBoundingClientRect();
        const atTranscriptEnd =
          viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
          24;
        if (atTranscriptEnd) {
          const lastTurnId = elements.at(-1)?.dataset.conversationTurnId;
          if (lastTurnId) {
            setActiveTurnId(lastTurnId);
          }
          return;
        }
        const readingLine =
          viewportRect.top + Math.min(160, viewport.clientHeight * 0.28);
        let activeElement = elements[0];
        for (const element of elements) {
          if (element.getBoundingClientRect().top > readingLine) {
            break;
          }
          activeElement = element;
        }
        const nextTurnId = activeElement?.dataset.conversationTurnId;
        if (nextTurnId) {
          setActiveTurnId(nextTurnId);
        }
      });
    };
    const resizeObserver = new ResizeObserver(updateActiveTurn);
    resizeObserver.observe(viewport);
    viewport.addEventListener('scroll', updateActiveTurn, { passive: true });
    updateActiveTurn();

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      viewport.removeEventListener('scroll', updateActiveTurn);
    };
  }, [turns, viewportRef]);

  if (!shouldShowTurnNavigator(turns.length)) {
    return null;
  }

  const navigateToTurn = (turnId: string): void => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const target = getTurnElements(viewport).find(
      (element) => element.dataset.conversationTurnId === turnId,
    );
    if (!target) {
      return;
    }
    const viewportRect = viewport.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    setActiveTurnId(turnId);
    viewport.scrollTo({
      top: Math.max(
        0,
        viewport.scrollTop + targetRect.top - viewportRect.top - 24,
      ),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  };

  return (
    <nav
      aria-label="对话轮次导航"
      className="pointer-events-auto absolute inset-y-5 left-3 z-20 hidden w-8 overflow-y-auto py-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:block"
    >
      <div className="flex min-h-full flex-col justify-center">
        {turns.map((turn, index) => {
          const active = turn.id === activeTurnId;
          const preview = previews.get(turn.id);
          return (
            <Tooltip key={turn.id} delayDuration={140}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="group flex h-2.5 shrink-0 items-center pl-2 focus-visible:outline-none"
                  aria-label={`跳转到第 ${index + 1} 轮对话：${preview?.question ?? ''}`}
                  aria-current={active ? 'step' : undefined}
                  onClick={() => navigateToTurn(turn.id)}
                >
                  <span
                    className={`h-px w-2.5 origin-left rounded-full transition-[transform,background-color,opacity] duration-200 ease-out group-hover:translate-x-1 group-hover:opacity-80 group-active:scale-x-90 group-focus-visible:translate-x-1 group-focus-visible:opacity-80 motion-reduce:transition-none ${
                      active
                        ? 'h-0.5 bg-foreground opacity-100'
                        : 'bg-foreground opacity-35'
                    }`}
                    aria-hidden="true"
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                align="center"
                sideOffset={9}
                className="w-72 rounded-xl px-3.5 py-3 shadow-[var(--shadow-floating)]"
              >
                <p className="line-clamp-2 text-[13px] font-medium leading-5 text-foreground">
                  {preview?.question}
                </p>
                {preview?.answer ? (
                  <div className="mt-1.5 flex gap-2 text-xs leading-5 text-secondary">
                    <span
                      className="mt-[0.46rem] size-1 shrink-0 rounded-full bg-tertiary"
                      aria-hidden="true"
                    />
                    <p className="line-clamp-2">{preview.answer}</p>
                  </div>
                ) : (
                  <p className="mt-1.5 text-xs text-tertiary">
                    等待 Agent 回复…
                  </p>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </nav>
  );
};
