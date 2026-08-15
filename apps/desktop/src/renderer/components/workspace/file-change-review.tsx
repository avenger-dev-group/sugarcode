import {
  Check,
  ChevronRight,
  CircleHelp,
  FileDiff,
  LoaderCircle,
  Square,
  X,
} from 'lucide-react';

import { useOrchestrationActions } from '@/renderer/components/orchestration/use-store';
import { Button } from '@/renderer/components/ui/button';

import type {
  FileChangeReviewPresentationState,
  FileChangeReviewProps,
} from './types';

const STATE_COPY: Record<
  FileChangeReviewPresentationState,
  Readonly<{ label: string; detail: string }>
> = {
  preparing: {
    label: 'Preparing file change',
    detail: 'Waiting for a durable review proposal',
  },
  applying: {
    label: 'Applying reviewed change',
    detail: 'The proposal is durable; the filesystem outcome is pending',
  },
  stopping: {
    label: 'Stopping file change',
    detail: 'Waiting for Core to record the final state',
  },
  uncertain: {
    label: 'File change status unavailable',
    detail: 'The connection closed before the durable outcome was observed',
  },
  applied: {
    label: 'File change applied',
    detail: 'Durable success result recorded',
  },
  failed: {
    label: 'File change failed',
    detail: 'Durable error result recorded',
  },
  interrupted: {
    label: 'File change stopped',
    detail: 'No review proposal or result was recorded',
  },
  outcomeUnknown: {
    label: 'File change outcome unknown',
    detail: 'A durable proposal exists without a durable result',
  },
};

const stateColor = (state: FileChangeReviewPresentationState): string => {
  switch (state) {
    case 'preparing':
    case 'applying':
    case 'stopping':
      return 'text-process';
    case 'failed':
      return 'text-destructive';
    case 'uncertain':
    case 'outcomeUnknown':
      return 'text-tertiary';
    case 'interrupted':
      return 'text-secondary';
    case 'applied':
      return 'text-primary';
  }
};

const StateIcon = ({
  state,
}: Readonly<{ state: FileChangeReviewPresentationState }>) => {
  const className = 'size-3.5';
  switch (state) {
    case 'preparing':
    case 'applying':
    case 'stopping':
      return (
        <LoaderCircle
          className={`${className} animate-spin motion-reduce:animate-none`}
          aria-hidden="true"
        />
      );
    case 'applied':
      return <Check className={className} aria-hidden="true" />;
    case 'failed':
      return <X className={className} aria-hidden="true" />;
    case 'interrupted':
      return <Square className={className} aria-hidden="true" />;
    case 'uncertain':
    case 'outcomeUnknown':
      return <CircleHelp className={className} aria-hidden="true" />;
  }
};

export const FileChangeReview = ({
  review,
  variant = 'card',
  language = 'en',
}: FileChangeReviewProps) => {
  const compact = variant === 'compact';
  const { openDiff, openFile } = useOrchestrationActions();
  const copy = STATE_COPY[review.state];
  const detail =
    review.state === 'failed' && review.errorKind
      ? `Failure kind ${review.errorKind}`
      : copy.detail;
  const change = review.change;
  const files = review.files ?? (change ? [change] : []);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);

  if (compact) {
    const action = language === 'zh'
      ? review.state === 'applied'
        ? '已编辑'
        : review.state === 'failed'
          ? '编辑失败'
          : review.state === 'preparing'
            ? '正在准备'
            : review.state === 'interrupted'
              ? '编辑已停止'
              : '正在编辑'
      : review.state === 'applied'
        ? 'Edited'
        : review.state === 'failed'
          ? 'Failed to edit'
          : review.state === 'preparing'
            ? 'Preparing'
            : review.state === 'interrupted'
              ? 'Stopped editing'
              : 'Editing';
    return (
      <section
        className="min-w-0 py-1"
        role={
          review.state === 'failed' || review.state === 'outcomeUnknown'
            ? 'alert'
            : 'status'
        }
        aria-label={
          language === 'zh'
            ? `${action}：${review.path}`
            : `${copy.label}: ${review.path}`
        }
        data-state={review.state}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            className={`mt-0.5 flex size-4 shrink-0 items-center justify-center ${stateColor(
              review.state,
            )}`}
          >
            <StateIcon state={review.state} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-5">
              <span className={stateColor(review.state)}>{action}</span>
              <code className="min-w-0 break-all font-mono text-[12px] text-secondary underline decoration-border underline-offset-2">
                <button
                  type="button"
                  className="break-all text-left hover:text-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    if (files.length > 0) {
                      openDiff(review.path, files);
                    } else {
                      openFile(review.path);
                    }
                  }}
                >
                  {review.path}
                </button>
              </code>
              {change ? (
                <>
                  <span className="ml-auto font-mono text-[10px] text-tertiary">
                    <span className="text-success">
                      +{additions}
                    </span>{' '}
                    <span className="text-destructive">
                      −{deletions}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => openDiff(review.path, files)}
                  >
                    <ChevronRight aria-hidden="true" />
                    {language === 'zh' ? '查看差异' : 'Review diff'}
                  </Button>
                </>
              ) : null}
            </div>
            {review.state === 'failed' || review.state === 'outcomeUnknown' ? (
              <p className={`mt-0.5 text-xs ${stateColor(review.state)}`}>
                {detail}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className="ml-10 max-w-[calc(100%-2.5rem)] min-w-0 overflow-hidden rounded-xl border bg-surface"
      role={
        review.state === 'failed' || review.state === 'outcomeUnknown'
          ? 'alert'
          : 'status'
      }
      aria-label={`${copy.label}: ${review.path}`}
      data-state={review.state}
    >
      <div className="flex min-w-0 gap-3 px-3.5 py-3">
        <div
          className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background ${stateColor(
            review.state,
          )}`}
        >
          <StateIcon state={review.state} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-sm font-medium leading-normal">{copy.label}</p>
            <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-tertiary">
              <FileDiff className="size-3" aria-hidden="true" />
              workspace write
            </span>
          </div>
          <code className="mt-1 block min-w-0 break-all font-mono text-xs font-normal leading-normal text-secondary">
            {review.path}
          </code>
          <p
            className={`mt-1.5 min-w-0 break-words font-mono text-[10px] tracking-[0.08em] ${stateColor(
              review.state,
            )}`}
          >
            {detail}
          </p>
          {change ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => openDiff(review.path, files)}
              >
                <ChevronRight aria-hidden="true" />
                Review diff
              </Button>
              <span className="font-mono text-[10px] text-tertiary">
                <span className="text-success">
                  +{additions}
                </span>{' '}
                <span className="text-destructive">−{deletions}</span>
              </span>
            </div>
          ) : null}
        </div>
      </div>

    </section>
  );
};
