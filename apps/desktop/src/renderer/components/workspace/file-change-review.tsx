import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileDiff,
  LoaderCircle,
  Square,
  X,
} from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';

import type {
  FileChangeReviewPresentationState,
  FileChangeReviewProps,
  UnifiedDiffLine,
} from './types';
import { useStore } from './use-store';

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

const lineClass = (line: UnifiedDiffLine): string => {
  switch (line.kind) {
    case 'addition':
      return 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300';
    case 'deletion':
      return 'bg-destructive/10 text-destructive';
    case 'context':
      return 'text-secondary';
  }
};

export const FileChangeReview = ({ review }: FileChangeReviewProps) => {
  const store = useStore(review.id);
  const copy = STATE_COPY[review.state];
  const detail =
    review.state === 'failed' && review.errorKind
      ? `Failure kind ${review.errorKind}`
      : copy.detail;
  const change = review.change;

  return (
    <section
      className="ml-10 min-w-0 overflow-hidden rounded-xl border bg-surface"
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
              workspace/apply-patch
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
                aria-expanded={store.expanded}
                aria-controls={`file-change-${change.id}`}
                onClick={store.toggleExpanded}
              >
                {store.expanded ? (
                  <ChevronDown aria-hidden="true" />
                ) : (
                  <ChevronRight aria-hidden="true" />
                )}
                {store.expanded ? 'Hide diff' : 'Review diff'}
              </Button>
              <span className="font-mono text-[10px] text-tertiary">
                <span className="text-emerald-700 dark:text-emerald-300">
                  +{change.additions}
                </span>{' '}
                <span className="text-destructive">−{change.deletions}</span>
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {change && store.expanded ? (
        <div id={`file-change-${change.id}`} className="border-t">
          <div
            className="max-h-96 overflow-auto font-mono text-xs font-normal leading-5"
            tabIndex={0}
            role="region"
            aria-label={`Unified diff for ${review.path}`}
          >
            {change.hunks.map((hunk) => (
              <div key={hunk.header}>
                <div className="sticky top-0 border-y bg-background px-3 py-1 text-[10px] text-tertiary">
                  {hunk.header}
                </div>
                {hunk.lines.map((line, index) => (
                  <div
                    key={`${hunk.header}:${index}`}
                    className={`grid min-w-max grid-cols-[3rem_3rem_1fr] ${lineClass(
                      line,
                    )}`}
                  >
                    <span className="select-none border-r px-2 text-right text-tertiary">
                      {line.oldLine ?? ''}
                    </span>
                    <span className="select-none border-r px-2 text-right text-tertiary">
                      {line.newLine ?? ''}
                    </span>
                    <code className="whitespace-pre px-3">
                      {line.kind === 'addition'
                        ? '+'
                        : line.kind === 'deletion'
                          ? '-'
                          : ' '}
                      {line.text}
                    </code>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <dl className="grid gap-x-4 gap-y-2 border-t px-3.5 py-3 font-mono text-[10px] text-tertiary sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="uppercase tracking-[0.12em]">Before</dt>
              <dd className="mt-0.5 break-all">
                {change.beforeBytes.toLocaleString('en-US')} bytes ·{' '}
                {change.beforeSha256}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="uppercase tracking-[0.12em]">After</dt>
              <dd className="mt-0.5 break-all">
                {change.afterBytes.toLocaleString('en-US')} bytes ·{' '}
                {change.afterSha256}
              </dd>
            </div>
            <div>
              <dt className="uppercase tracking-[0.12em]">Newlines</dt>
              <dd className="mt-0.5">
                {change.newlineStyle === 'lf' ? 'LF' : 'CRLF'} ·{' '}
                {change.finalNewline ? 'final newline' : 'no final newline'}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </section>
  );
};
