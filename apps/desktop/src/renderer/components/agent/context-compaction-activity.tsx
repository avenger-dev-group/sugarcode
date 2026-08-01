import { Check, ChevronsUp, LoaderCircle, TriangleAlert } from 'lucide-react';

import type { ContextBudget } from '@/renderer/components/thread/context-budget';
import { formatTokenCount } from '@/renderer/components/thread/context-budget';

export type ContextCompactionActivityViewModel = Readonly<{
  id: string;
  ordinal: number;
  state: 'compacting' | 'completed' | 'failed' | 'interrupted';
  preContextBytes: number;
  contextWindowTokens?: number;
  estimatedPreContextTokens?: number;
  budget?: ContextBudget;
  sourceMessages: number;
  sourceBytes: number;
  sourceSha256: string;
  postContextBytes?: number;
  summaryBytes?: number;
  summarySha256?: string;
  errorKind?: string;
}>;

const formatBytes = (bytes: number): string =>
  new Intl.NumberFormat(undefined, {
    notation: bytes >= 1024 * 1024 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(bytes);

export const ContextCompactionActivity = ({
  activity,
}: Readonly<{ activity: ContextCompactionActivityViewModel }>) => {
  const label =
    activity.state === 'compacting'
      ? 'Compacting context…'
      : activity.state === 'completed'
        ? 'Context compacted'
        : activity.state === 'failed'
          ? 'Context compaction failed'
          : 'Context compaction interrupted';
  const Icon =
    activity.state === 'compacting'
      ? LoaderCircle
      : activity.state === 'completed'
        ? Check
        : activity.state === 'failed'
          ? TriangleAlert
          : ChevronsUp;

  return (
    <details
      className="ml-10 rounded-xl border border-border/70 bg-surface/60 px-3 py-2"
      aria-label={label}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-secondary marker:hidden">
        <Icon
          aria-hidden="true"
          className={`size-4 shrink-0 ${
            activity.state === 'compacting' ? 'animate-spin' : ''
          }`}
        />
        <span>{label}</span>
        {activity.estimatedPreContextTokens !== undefined &&
        activity.contextWindowTokens !== undefined ? (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-tertiary">
            ≈ {formatTokenCount(activity.estimatedPreContextTokens)} /{' '}
            {formatTokenCount(activity.contextWindowTokens)} tokens
          </span>
        ) : null}
      </summary>
      {activity.budget ? (
        <p className="mt-2 border-t border-border/60 pt-2 text-xs font-normal leading-5 text-secondary">
          SugarCode compacts near{' '}
          {formatTokenCount(activity.budget.compactionTargetTokens)} tokens,
          before the full window, reserving{' '}
          {formatTokenCount(activity.budget.outputReserveTokens)} for output
          and {formatTokenCount(activity.budget.recoveryReserveTokens)} for
          recovery. Token usage shown here is a conservative estimate.
        </p>
      ) : null}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border/60 pt-3 font-mono text-[10px] text-tertiary">
        <dt>Ordinal</dt>
        <dd>{activity.ordinal}</dd>
        <dt>Strategy</dt>
        <dd>modelGeneratedActiveTurnV1</dd>
        <dt>Before</dt>
        <dd>{formatBytes(activity.preContextBytes)} bytes</dd>
        {activity.postContextBytes !== undefined ? (
          <>
            <dt>After</dt>
            <dd>{formatBytes(activity.postContextBytes)} bytes</dd>
          </>
        ) : null}
        <dt>Source bytes</dt>
        <dd>{formatBytes(activity.sourceBytes)} bytes</dd>
        <dt>Source messages</dt>
        <dd>{activity.sourceMessages}</dd>
        <dt>Source SHA-256</dt>
        <dd className="min-w-0 break-all">{activity.sourceSha256}</dd>
        {activity.summarySha256 ? (
          <>
            <dt>Summary bytes</dt>
            <dd>{formatBytes(activity.summaryBytes ?? 0)} bytes</dd>
            <dt>Summary SHA-256</dt>
            <dd className="min-w-0 break-all">{activity.summarySha256}</dd>
          </>
        ) : null}
        {activity.errorKind ? (
          <>
            <dt>Outcome</dt>
            <dd>{activity.errorKind}</dd>
          </>
        ) : null}
      </dl>
    </details>
  );
};
