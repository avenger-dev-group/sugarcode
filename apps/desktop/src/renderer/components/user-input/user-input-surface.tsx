import { Check, ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';

import type { UserInputSurfaceProps } from './types';
import { useStore } from './use-store';

export const UserInputSurface = (props: UserInputSurfaceProps) => {
  const store = useStore(props);
  const question = store.question;
  if (!question) {
    return null;
  }

  const customAnswer = store.currentSelection
    ? ''
    : store.currentAnswer;

  return (
    <section
      className="max-w-2xl overflow-hidden rounded-xl border bg-background shadow-sm"
      aria-labelledby={`${props.request.id}:question`}
    >
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-secondary">需要你的选择</p>
          <p className="mt-0.5 truncate text-xs text-tertiary">
            {question.header}
          </p>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-tertiary">
          {store.questionIndex + 1} / {store.questionCount}
        </span>
      </header>

      <div className="space-y-4 p-4">
        <p
          id={`${props.request.id}:question`}
          className="text-sm font-medium leading-relaxed text-primary"
        >
          {question.question}
        </p>

        <div className="space-y-2" role="radiogroup" aria-label={question.question}>
          {question.options.map((option) => {
            const selected = store.currentSelection === option.label;
            return (
              <Button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={selected}
                variant="outline"
                className={`h-auto min-h-14 w-full justify-start gap-3 whitespace-normal px-3.5 py-2.5 text-left font-normal ${
                  selected
                    ? 'border-primary/40 bg-primary/10 hover:bg-primary/10'
                    : 'hover:bg-surface'
                }`}
                onClick={() => store.selectOption(option.label)}
                disabled={store.submitting}
              >
                <span
                  className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
                    selected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input bg-background'
                  }`}
                  aria-hidden="true"
                >
                  {selected ? <Check className="size-2.5" strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-primary">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-xs leading-normal text-secondary">
                    {option.description}
                  </span>
                </span>
              </Button>
            );
          })}
        </div>

        <div>
          <label
            htmlFor={`${props.request.id}:${question.id}:custom`}
            className="mb-1.5 block text-xs text-secondary"
          >
            或输入自己的回答
          </label>
          <Input
            id={`${props.request.id}:${question.id}:custom`}
            value={customAnswer}
            onChange={(event) => store.setCustomAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && store.canContinue) {
                event.preventDefault();
                void store.next();
              }
            }}
            placeholder="输入其他回答…"
            maxLength={2048}
            disabled={store.submitting}
          />
        </div>

        {store.error ? (
          <p className="text-xs text-destructive" role="alert">
            {store.error}
          </p>
        ) : null}
        {store.answerTooLong ? (
          <p className="text-xs text-destructive" role="alert">
            回答不能超过 2 KB。
          </p>
        ) : null}

        <footer className="flex items-center justify-between gap-3 pt-1">
          <Button
            type="button"
            variant="ghost"
            onClick={store.previous}
            disabled={store.questionIndex === 0 || store.submitting}
          >
            <ChevronLeft aria-hidden="true" />
            上一步
          </Button>
          <Button
            type="button"
            onClick={() => void store.next()}
            disabled={!store.canContinue}
          >
            {store.submitting ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : store.isLastQuestion ? null : (
              <ChevronRight aria-hidden="true" />
            )}
            {store.submitting
              ? '正在提交'
              : store.isLastQuestion
                ? '提交回答'
                : '下一步'}
          </Button>
        </footer>
      </div>
    </section>
  );
};
