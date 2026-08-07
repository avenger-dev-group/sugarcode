import { FileDiff } from 'lucide-react';

import type {
  FileChangeReviewFile,
  UnifiedDiffLine,
} from '../types';

const lineClass = (line: UnifiedDiffLine): string => {
  switch (line.kind) {
    case 'addition':
      return 'bg-success/10 text-success';
    case 'deletion':
      return 'bg-destructive/10 text-destructive';
    case 'context':
      return 'text-secondary';
  }
};

export const FileDiffWorkbench = ({
  path,
  changes,
}: Readonly<{
  path: string;
  changes: readonly FileChangeReviewFile[];
}>) => {
  const additions = changes.reduce((total, change) => total + change.additions, 0);
  const deletions = changes.reduce((total, change) => total + change.deletions, 0);

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label={`变更审阅：${path}`}>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <FileDiff className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-secondary" title={path}>
          {path}
        </code>
        <span className="shrink-0 font-mono text-[10px]">
          <span className="text-success">+{additions}</span>{' '}
          <span className="text-destructive">−{deletions}</span>
        </span>
      </header>
      <div className="workspace-code-scroll min-h-0 flex-1 overflow-auto" tabIndex={0} aria-label={`Diff：${path}`}>
        {changes.map((change, changeIndex) => (
          <div key={change.id} className={changeIndex > 0 ? 'border-t-4 border-border' : undefined}>
            {changes.length > 1 ? (
              <div className="sticky top-0 z-20 border-b bg-surface px-3 py-1.5 font-mono text-[10px] text-tertiary">
                第 {changeIndex + 1} 次编辑 · {change.kind}
              </div>
            ) : null}
            {change.hunks.map((hunk, hunkIndex) => (
              <div key={`${change.id}:${hunkIndex}`}>
                <div className="sticky top-0 z-10 border-y bg-surface px-3 py-1.5 font-mono text-[10px] text-tertiary">
                  {hunk.header}
                </div>
                {hunk.lines.map((line, lineIndex) => (
                  <div
                    key={`${hunk.header}:${lineIndex}`}
                    className={`grid min-w-max grid-cols-[3.5rem_3.5rem_1fr] font-mono text-xs font-normal leading-5 ${lineClass(line)}`}
                  >
                    <span className="select-none border-r px-2 text-right text-tertiary">{line.oldLine ?? ''}</span>
                    <span className="select-none border-r px-2 text-right text-tertiary">{line.newLine ?? ''}</span>
                    <code className="whitespace-pre px-3">
                      {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' '}
                      {line.text}
                    </code>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
};
