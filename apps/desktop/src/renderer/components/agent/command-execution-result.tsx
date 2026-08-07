import {
  CircleAlert,
  CircleCheck,
  Clock3,
  FileOutput,
  ShieldCheck,
  SquareTerminal,
} from 'lucide-react';

import type { CommandExecutionResultViewModel } from './types';

const STATE_LABELS = {
  observed: 'Execution result observed',
  stopping: 'Execution result stopping',
  uncertain: 'Execution result status unavailable',
  recorded: 'Execution result recorded',
} as const;

const formatBytes = (bytes: number): string =>
  `${bytes.toLocaleString('en-US')} B`;

const outcomeLabel = (result: CommandExecutionResultViewModel): string => {
  if (result.outcome.type === 'error') {
    return `Execution failed: ${result.outcome.kind}`;
  }
  if (result.outcome.type === 'workspacePatch') {
    return `Workspace patch applied to ${result.outcome.filesChanged} file${result.outcome.filesChanged === 1 ? '' : 's'}`;
  }
  switch (result.outcome.outcome.type) {
    case 'exitCode':
      return result.outcome.outcome.code === 0
        ? 'Command exited successfully'
        : `Command exited with code ${result.outcome.outcome.code}`;
    case 'signal':
      return `Command ended by signal ${result.outcome.outcome.signal}`;
    case 'timedOut':
      return 'Command timed out';
  }
};

const isFailure = (result: CommandExecutionResultViewModel): boolean =>
  result.outcome.type === 'error' ||
  (result.outcome.type === 'process' &&
    (result.outcome.outcome.type !== 'exitCode' ||
      result.outcome.outcome.code !== 0));

export const CommandExecutionResult = ({
  result,
}: Readonly<{ result: CommandExecutionResultViewModel }>) => {
  const label = outcomeLabel(result);
  const failure = isFailure(result);
  return (
    <div
      className="mt-2.5 min-w-0 rounded-lg border bg-background/60 p-2.5"
      role={failure ? 'alert' : 'status'}
      aria-label={`${STATE_LABELS[result.state]}: ${label}`}
      data-execution-result-state={result.state}
      data-execution-outcome={
        result.outcome.type === 'process'
          ? result.outcome.outcome.type
          : result.outcome.type
      }
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium leading-normal">
          {failure ? (
            <CircleAlert
              className="size-3.5 shrink-0 text-destructive"
              aria-hidden="true"
            />
          ) : (
            <CircleCheck
              className="size-3.5 shrink-0 text-primary"
              aria-hidden="true"
            />
          )}
          <span className="break-words">{label}</span>
        </p>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-tertiary">
          {STATE_LABELS[result.state]}
        </span>
      </div>
      {result.outcome.type === 'error' ? (
        <code className="mt-2 block min-w-0 break-all rounded-md border px-2 py-1.5 font-mono text-[10px] leading-normal text-destructive">
          {result.outcome.kind}
        </code>
      ) : result.outcome.type === 'workspacePatch' ? (
        <p className="mt-2 rounded-md border px-2 py-1.5 font-mono text-[10px] text-secondary">
          {result.outcome.filesChanged.toLocaleString('en-US')} file
          {result.outcome.filesChanged === 1 ? '' : 's'} changed atomically
        </p>
      ) : (
        <>
          <dl className="mt-2 grid min-w-0 grid-cols-1 gap-1.5 text-[10px] min-[390px]:grid-cols-3">
            <div className="min-w-0 rounded-md border px-2 py-1.5">
              <dt className="flex items-center gap-1 font-mono uppercase tracking-[0.1em] text-tertiary">
                <Clock3 className="size-3" aria-hidden="true" /> Duration
              </dt>
              <dd className="mt-0.5 font-mono text-secondary">
                {result.outcome.durationMs.toLocaleString('en-US')} ms
              </dd>
            </div>
            <div className="min-w-0 rounded-md border px-2 py-1.5">
              <dt className="flex items-center gap-1 font-mono uppercase tracking-[0.1em] text-tertiary">
                <FileOutput className="size-3" aria-hidden="true" /> Stdout
              </dt>
              <dd className="mt-0.5 break-words font-mono text-secondary">
                {formatBytes(result.outcome.stdoutBytes)}
                {result.outcome.stdoutTruncated ? ' · truncated' : ''}
              </dd>
            </div>
            <div className="min-w-0 rounded-md border px-2 py-1.5">
              <dt className="flex items-center gap-1 font-mono uppercase tracking-[0.1em] text-tertiary">
                <SquareTerminal className="size-3" aria-hidden="true" /> Stderr
              </dt>
              <dd className="mt-0.5 break-words font-mono text-secondary">
                {formatBytes(result.outcome.stderrBytes)}
                {result.outcome.stderrTruncated ? ' · truncated' : ''}
              </dd>
            </div>
          </dl>
          <div className="mt-2 flex min-w-0 flex-wrap gap-1.5 font-mono text-[10px] text-tertiary">
            <span className="rounded-md border px-1.5 py-1">
              {result.outcome.encoding}
            </span>
            <span className="flex min-w-0 items-center gap-1 rounded-md border px-1.5 py-1">
              <ShieldCheck className="size-3 shrink-0" aria-hidden="true" />
              <span className="break-all">{result.outcome.sandboxPolicy}</span>
            </span>
            <span className="min-w-0 break-all rounded-md border px-1.5 py-1">
              {result.outcome.networkPolicy}
            </span>
          </div>
        </>
      )}
    </div>
  );
};
