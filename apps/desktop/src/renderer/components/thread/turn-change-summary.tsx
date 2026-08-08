import { ChevronDown, FileDiff } from 'lucide-react';

import { useOrchestrationStore } from '@/renderer/components/orchestration/use-store';

import { collectTurnChangeSummaryFiles } from './turn-change-summary-data';
import type { TurnChangeSummaryProps } from './types';
import { useActivityDisclosureStore } from './use-store';

export const TurnChangeSummary = ({
  turnId,
  activities,
  language,
}: TurnChangeSummaryProps) => {
  const { openDiff, openFile } = useOrchestrationStore();
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
      className="group/changes min-w-0 overflow-hidden rounded-xl border border-border-subtle bg-background"
      aria-label={label}
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-3.5 py-2 outline-none transition-colors duration-200 hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <FileDiff className="size-5 text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-primary">{label}</span>
          <span className="mt-0.5 flex gap-2 font-mono text-xs">
            <span className="text-success">+{additions}</span>
            <span className="text-destructive">−{deletions}</span>
          </span>
        </span>
        <ChevronDown
          className="size-3.5 shrink-0 text-tertiary transition-transform duration-200 motion-reduce:transition-none group-open/changes:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none group-open/changes:grid-rows-[1fr] group-open/changes:opacity-100">
        <div className="min-h-0 overflow-hidden">
          <div className="max-h-64 divide-y divide-border-subtle overflow-y-auto overscroll-contain border-t border-border-subtle px-1.5 py-1">
            {files.map((entry) => {
              const additions = entry.reviews.reduce(
                (total, review) => total + review.additions,
                0,
              );
              const deletions = entry.reviews.reduce(
                (total, review) => total + review.deletions,
                0,
              );
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="group/file flex min-h-10 w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm font-normal leading-normal transition-colors duration-150 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                  onClick={() => {
                    if (entry.reviews.length > 0) {
                      openDiff(entry.file.path, entry.reviews);
                    } else {
                      openFile(entry.file.path);
                    }
                  }}
                  title={entry.file.path}
                  aria-label={
                    language === 'zh'
                      ? `查看 ${entry.file.path} 的差异`
                      : `Review changes for ${entry.file.path}`
                  }
                >
                  <code className="min-w-0 flex-1 truncate font-mono text-sm font-normal text-primary">
                    {entry.file.path}
                  </code>
                  {entry.reviews.length > 0 ? (
                    <span className="flex shrink-0 items-center gap-2 font-mono text-sm tabular-nums">
                      <span className="text-success">+{additions}</span>
                      <span className="text-destructive">−{deletions}</span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </details>
  );
};
