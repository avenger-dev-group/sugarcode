import { ChevronDown, FileDiff } from 'lucide-react';

import { FileChangeReview } from '@/renderer/components/workspace/file-change-review';

import { collectTurnChangeSummaryFiles } from './turn-change-summary-data';
import type { TurnChangeSummaryProps } from './types';
import { useActivityDisclosureStore } from './use-store';

export const TurnChangeSummary = ({
  turnId,
  activities,
  language,
}: TurnChangeSummaryProps) => {
  const files = collectTurnChangeSummaryFiles(activities);
  const store = useActivityDisclosureStore(`turn-changes:${turnId}`, true);
  if (files.length === 0) {
    return null;
  }
  const additions = files.reduce(
    (total, entry) =>
      total + entry.reviews.reduce(
        (fileTotal, review) => fileTotal + review.additions,
        0,
      ),
    0,
  );
  const deletions = files.reduce(
    (total, entry) =>
      total + entry.reviews.reduce(
        (fileTotal, review) => fileTotal + review.deletions,
        0,
      ),
    0,
  );
  const label = language === 'zh'
    ? `已编辑 ${files.length} 个文件`
    : `Edited ${files.length} ${files.length === 1 ? 'file' : 'files'}`;

  return (
    <details
      open={store.expanded}
      onToggle={(event) => store.setExpanded(event.currentTarget.open)}
      className="group/changes min-w-0 overflow-hidden rounded-xl border bg-surface"
      aria-label={label}
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-3.5 py-2 outline-none transition-colors hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-background text-secondary">
          <FileDiff className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-primary">{label}</span>
          <span className="mt-0.5 flex gap-2 font-mono text-[11px]">
            <span className="text-success">+{additions}</span>
            <span className="text-destructive">−{deletions}</span>
          </span>
        </span>
        <span className="text-xs font-medium text-secondary">
          {language === 'zh' ? '审核' : 'Review'}
        </span>
        <ChevronDown
          className="size-3.5 shrink-0 text-tertiary transition-transform motion-reduce:transition-none group-open/changes:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="max-h-64 overflow-y-auto overscroll-contain border-t px-3 py-1.5">
        {files.map((entry) =>
          entry.reviews.length > 0 ? (
            <FileChangeReview
              key={entry.id}
              review={{
                id: entry.id,
                path: entry.file.path,
                state: 'applied',
                change: entry.reviews[0],
                files: entry.reviews,
              }}
              variant="compact"
              language={language}
            />
          ) : (
            <div
              key={entry.id}
              className="flex min-w-0 items-center gap-2.5 py-2 text-sm text-secondary"
            >
              <FileDiff className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
              <code className="min-w-0 flex-1 truncate font-mono text-xs">
                {entry.file.path}
              </code>
              <span className="text-xs text-tertiary">
                {language === 'zh' ? '已修改' : 'Changed'}
              </span>
            </div>
          ),
        )}
      </div>
    </details>
  );
};
