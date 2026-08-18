import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Pencil,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  Button,
  buttonVariants,
} from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/renderer/components/ui/tooltip';
import { cn } from '@/renderer/utils/class-name';

import type { UserInputSurfaceProps } from './types';
import { useStore } from './use-store';
import {
  hasHorizontalOverflow,
  shouldConfirmCustomAnswer,
} from './state';

const RECOMMENDED_SUFFIX = /\s*[（(](?:推荐|recommended)[）)]\s*$/iu;

const optionDisplayLabel = (label: string): string =>
  label.replace(RECOMMENDED_SUFFIX, '').trim() || label;

type UserInputOptionProps = Readonly<{
  description: string;
  disabled: boolean;
  index: number;
  label: string;
  onSelect: () => void;
  selected: boolean;
}>;

const UserInputOption = ({
  description,
  disabled,
  index,
  label,
  onSelect,
  selected,
}: UserInputOptionProps) => {
  const clipRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const displayLabel = optionDisplayLabel(label);
  const tooltipLabel = description
    ? `${displayLabel} ${description}`
    : displayLabel;

  const measureOverflow = useCallback(() => {
    const clip = clipRef.current;
    const text = textRef.current;
    if (!clip || !text) return false;

    const range = document.createRange();
    range.selectNodeContents(text);
    const contentWidth = Math.max(
      text.scrollWidth,
      range.getBoundingClientRect().width,
    );
    const nextOverflowing = hasHorizontalOverflow(
      contentWidth,
      clip.clientWidth,
    );
    setOverflowing(nextOverflowing);
    if (!nextOverflowing) {
      setTooltipOpen(false);
    }
    return nextOverflowing;
  }, []);

  useLayoutEffect(() => {
    const clip = clipRef.current;
    const text = textRef.current;
    if (!clip || !text) return;

    measureOverflow();
    const frame = window.requestAnimationFrame(measureOverflow);
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(clip);
    observer.observe(text);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [description, displayLabel, index, measureOverflow]);

  const option = (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-slot="button"
      data-variant="ghost"
      data-size="default"
      data-user-input-primary={index === 0 ? '' : undefined}
      className={cn(
        buttonVariants({ variant: 'ghost' }),
        'h-auto min-h-12 w-full min-w-0 justify-start gap-3 overflow-hidden rounded-xl px-2.5 py-2 text-left font-normal',
        selected ? 'bg-surface' : 'hover:bg-surface',
      )}
      onClick={onSelect}
      disabled={disabled}
      title={overflowing && !tooltipOpen ? tooltipLabel : undefined}
    >
      <span
        className={`grid size-7 shrink-0 place-items-center rounded-full border text-xs tabular-nums ${
          selected
            ? 'border-brand bg-brand text-brand-foreground'
            : 'border-border bg-surface text-secondary'
        }`}
        aria-hidden="true"
      >
        {index + 1}
      </span>
      <span ref={clipRef} className="min-w-0 flex-1 overflow-hidden">
        <span
          ref={textRef}
          className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        >
          <span className="text-sm font-medium text-primary">
            {displayLabel}
          </span>
          {index === 0 ? (
            <span className="mx-2 inline-flex translate-y-[-1px] rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-secondary">
              推荐
            </span>
          ) : (
            <span aria-hidden="true">&nbsp;&nbsp;</span>
          )}
          <span className="text-xs leading-normal text-secondary">
            {description}
          </span>
        </span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
    </button>
  );

  return (
    <Tooltip
      open={overflowing && tooltipOpen}
      onOpenChange={(open) => {
        if (!open) {
          setTooltipOpen(false);
          return;
        }
        setTooltipOpen(measureOverflow());
      }}
    >
      <TooltipTrigger asChild>{option}</TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-[min(36rem,calc(100vw-2rem))] whitespace-normal break-words"
      >
        <span className="font-medium">{displayLabel}</span>
        <span className="ml-2 text-secondary">{description}</span>
      </TooltipContent>
    </Tooltip>
  );
};

export const UserInputSurface = (props: UserInputSurfaceProps) => {
  const store = useStore(props);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const customAnswerComposingRef = useRef(false);
  const question = store.question;

  useEffect(() => {
    const target = surfaceRef.current?.querySelector<HTMLElement>(
      '[data-user-input-primary]',
    );
    target?.focus();
  }, [props.request.id, store.questionIndex]);

  if (!question) {
    return null;
  }

  return (
    <section
      ref={surfaceRef}
      className="flex max-h-[min(30rem,58vh)] min-h-52 flex-col overflow-hidden rounded-2xl border bg-background shadow-[0_18px_60px_var(--shadow-soft)] animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
      aria-labelledby={`${props.request.id}:question`}
      aria-busy={store.submitting}
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-border-subtle px-4 py-3">
        <p
          id={`${props.request.id}:question`}
          className="min-w-0 flex-1 pt-0.5 text-sm font-medium leading-relaxed text-primary"
        >
          {question.question}
        </p>
        <div className="flex shrink-0 items-center gap-0.5 text-tertiary">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={store.previous}
            disabled={store.questionIndex === 0 || store.submitting}
            aria-label="上一个问题"
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span className="min-w-12 text-center text-xs tabular-nums">
            {store.questionIndex + 1} / {store.questionCount}
          </span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={store.next}
            disabled={
              store.questionIndex === store.questionCount - 1 ||
              store.submitting
            }
            aria-label="下一个问题"
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={store.cancel}
            disabled={store.submitting}
            aria-label="取消这组问题并继续任务"
            title="取消这组问题并继续任务"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        <div className="space-y-1" role="radiogroup" aria-label={question.question}>
          {question.options.map((option, index) => {
            const selected = store.currentSelection === option.label;
            return (
              <UserInputOption
                key={option.label}
                label={option.label}
                description={option.description}
                index={index}
                selected={selected}
                onSelect={() => store.selectOption(option.label)}
                disabled={store.submitting}
              />
            );
          })}
        </div>

        <div className="mt-1 flex min-h-11 items-center gap-2 rounded-xl px-2.5 focus-within:bg-surface">
          <span className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-surface text-tertiary">
            <Pencil className="size-3.5" aria-hidden="true" />
          </span>
          <Input
            id={`${props.request.id}:${question.id}:custom`}
            value={store.customAnswer}
            onChange={(event) => store.setCustomAnswer(event.target.value)}
            onCompositionStart={() => {
              customAnswerComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              customAnswerComposingRef.current = false;
            }}
            onKeyDown={(event) => {
              if (
                shouldConfirmCustomAnswer(
                  event.key,
                  store.canConfirmCustom,
                  customAnswerComposingRef.current ||
                    event.nativeEvent.isComposing,
                  event.nativeEvent.keyCode,
                )
              ) {
                event.preventDefault();
                store.confirmCustomAnswer();
              }
            }}
            placeholder="输入自己的回答…"
            maxLength={2048}
            disabled={store.submitting}
            className="h-9 min-w-0 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
            aria-label="输入自己的回答"
          />
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={store.confirmCustomAnswer}
            disabled={!store.canConfirmCustom}
            aria-label="确认自定义回答"
          >
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border-subtle px-3 py-2">
        <div className="min-w-0 flex-1">
          {store.error ? (
            <p className="text-xs text-destructive" role="alert">
              {store.error}
            </p>
          ) : store.answerTooLong ? (
            <p className="text-xs text-destructive" role="alert">
              回答不能超过 2 KB。
            </p>
          ) : (
            <p className="truncate text-xs text-tertiary">{question.header}</p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={store.skip}
          disabled={store.submitting}
        >
          {store.submitting ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : null}
          {store.submitting ? '正在提交' : '跳过'}
        </Button>
      </footer>
    </section>
  );
};
