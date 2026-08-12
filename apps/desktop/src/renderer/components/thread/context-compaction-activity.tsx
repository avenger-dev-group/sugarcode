import { Archive, CircleAlert, LoaderCircle } from 'lucide-react';

import type { ContextCompactionActivityViewModel } from './types';

const formatTokens = (value: number): string =>
  value >= 1_000
    ? `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
    : String(value);

const strategyLabel = (
  strategy: ContextCompactionActivityViewModel['strategy'],
): string => {
  switch (strategy) {
    case 'openaiNative':
      return 'OpenAI native';
    case 'anthropicNative':
      return 'Anthropic native';
    case 'applicationSummary':
      return 'SugarCode summary';
  }
};

export const ContextCompactionActivity = ({
  activity,
}: Readonly<{ activity: ContextCompactionActivityViewModel }>) => {
  const running = activity.state === 'running';
  const failed = activity.state === 'failed' || activity.state === 'interrupted';
  const title = running
    ? '正在压缩上下文…'
    : failed
      ? activity.state === 'interrupted'
        ? '上下文压缩已中断'
        : '上下文压缩失败，已保留原上下文'
      : activity.beforeContextTokens !== undefined &&
          activity.afterContextTokens !== undefined
        ? `上下文已从 ${formatTokens(activity.beforeContextTokens)} 压缩至 ${formatTokens(activity.afterContextTokens)}`
        : '上下文压缩已完成';

  return (
    <details className="group rounded-lg border bg-surface/40 px-3 py-2 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-secondary">
        {running ? (
          <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : failed ? (
          <CircleAlert className="size-3.5 text-danger" aria-hidden="true" />
        ) : (
          <Archive className="size-3.5 text-success" aria-hidden="true" />
        )}
        <span>{title}</span>
      </summary>
      <div className="mt-2 grid gap-1 border-t pt-2 text-xs text-tertiary">
        <span>
          {activity.trigger === 'manual'
            ? '手动触发'
            : activity.trigger === 'recovery'
              ? '超限恢复'
              : '自动触发'}
          {' · '}{strategyLabel(activity.strategy)}
        </span>
        {activity.durationMs !== undefined ? (
          <span>耗时 {(activity.durationMs / 1_000).toFixed(1)} 秒</span>
        ) : null}
        {activity.opaqueCheckpoint ? (
          <span>供应商加密 checkpoint，摘要内容不可查看。</span>
        ) : null}
        {activity.message ? <span>{activity.message}</span> : null}
        {activity.readableSummary ? (
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 font-sans text-xs text-secondary">
            {activity.readableSummary}
          </pre>
        ) : null}
      </div>
    </details>
  );
};
