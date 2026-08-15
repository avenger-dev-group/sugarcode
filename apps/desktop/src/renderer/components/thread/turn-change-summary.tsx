import { ChevronDown, FileDiff } from 'lucide-react';

import { useOrchestrationActions } from '@/renderer/components/orchestration/use-store';

import { collectTurnChangeSummaryFiles } from './turn-change-summary-data';
import type { TurnChangeSummaryProps } from './types';
import { useActivityDisclosureStore } from './use-store';

export const TurnChangeSummary = ({
  turnId,
  activities,
  language,
}: TurnChangeSummaryProps) => {
  const { openDiff, openFile } = useOrchestrationActions();
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
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2.5 px-3.5 py-2 outline-none transition-colors duration-200 hover:bg-surface focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <FileDiff className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className="text-sm font-medium text-secondary">{label}</span>
          <span className="flex gap-1.5 font-mono text-[11px] tabular-nums">
            {additions > 0 ? (
              <span className="text-success">+{additions}</span>
            ) : null}
            {deletions > 0 ? (
              <span className="text-destructive">−{deletions}</span>
            ) : null}
          </span>
        </span>
        <ChevronDown
          className="size-3.5 shrink-0 text-tertiary transition-transform duration-200 motion-reduce:transition-none group-open/changes:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none group-open/changes:grid-rows-[1fr] group-open/changes:opacity-100">
        <div className="min-h-0 overflow-hidden">
          <div className="max-h-64 overflow-y-auto overscroll-y-auto border-t border-border-subtle">
            {files.map((entry) => {
              const additions = entry.reviews.reduce(
                (total, review) => total + review.additions,
                0,
              );
              const deletions = entry.reviews.reduce(
                (total, review) => total + review.deletions,
                0,
              );
              const separatorIndex = Math.max(
                entry.file.path.lastIndexOf('/'),
                entry.file.path.lastIndexOf('\\'),
              );
              const directory = separatorIndex >= 0
                ? entry.file.path.slice(0, separatorIndex + 1)
                : '';
              const fileName = entry.file.path.slice(separatorIndex + 1);
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="group/file flex min-h-9 w-full min-w-0 items-center gap-3 border-b border-border-subtle px-3.5 py-1.5 text-left font-normal transition-colors duration-150 last:border-b-0 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
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
                  <code className="min-w-0 flex-1 truncate font-mono text-xs font-normal leading-5">
                    <span className="text-tertiary">{directory}</span>
                    <span className="text-secondary transition-colors duration-150 group-hover/file:text-primary">
                      {fileName}
                    </span>
                  </code>
                  {entry.reviews.length > 0 ? (
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
                      {additions > 0 ? (
                        <span className="text-success">+{additions}</span>
                      ) : null}
                      {deletions > 0 ? (
                        <span className="text-destructive">−{deletions}</span>
                      ) : null}
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
