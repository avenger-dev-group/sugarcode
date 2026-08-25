import {
  Ban,
  Check,
  CircleDashed,
  CircleHelp,
  PlugZap,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';

import type {
  McpActivityState,
  McpActivityTimelineProps,
} from './types';

const PRESENTATION: Record<
  McpActivityState,
  Readonly<{
    label: string;
    detail: string;
    Icon: typeof Check;
    tone: string;
  }>
> = {
  awaiting: {
    label: '等待授权',
    detail: '尚未记录执行尝试。',
    Icon: CircleDashed,
    tone: 'text-process',
  },
  denied: {
    label: '已拒绝',
    detail: '已记录拒绝本次调用的决定。',
    Icon: Ban,
    tone: 'text-destructive',
  },
  approved: {
    label: '已允许',
    detail: '调用已进入队列，尚未记录执行尝试。',
    Icon: ShieldCheck,
    tone: 'text-process',
  },
  attempted: {
    label: '已开始尝试',
    detail: '执行可能已经开始，结果仍在等待中。',
    Icon: CircleDashed,
    tone: 'text-process',
  },
  succeeded: {
    label: '已完成',
    detail: '已记录可持久保存的 MCP 结果凭据。',
    Icon: Check,
    tone: 'text-foreground',
  },
  toolError: {
    label: '工具返回错误',
    detail: '服务完成调用，但将结果标记为错误。',
    Icon: TriangleAlert,
    tone: 'text-destructive',
  },
  failed: {
    label: '调用失败',
    detail: '已记录连接或协议错误。',
    Icon: TriangleAlert,
    tone: 'text-destructive',
  },
  stopped: {
    label: '已停止',
    detail: '任务在完整结果记录前已经结束。',
    Icon: Ban,
    tone: 'text-secondary',
  },
  uncertain: {
    label: '结果未知',
    detail: '存在执行尝试，但没有可持久保存的结果凭据。',
    Icon: CircleHelp,
    tone: 'text-destructive',
  },
};

export const McpActivityTimeline = ({
  activities,
}: McpActivityTimelineProps) => (
  <section
    className="ml-0 rounded-xl border bg-surface/55 sm:ml-10"
    aria-label={`${activities.length} 次 MCP 工具调用`}
  >
    <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
      <div className="flex items-center gap-2">
        <PlugZap className="size-4 text-tertiary" aria-hidden="true" />
        <h3 className="text-sm font-medium">MCP 调用记录</h3>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-tertiary">
        {activities.length}/4 次调用
      </span>
    </header>
    <ol className="divide-y">
      {activities.map((activity, index) => {
        const presentation = PRESENTATION[activity.state];
        const { Icon } = presentation;
        return (
          <li key={activity.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 px-4 py-4">
            <div className="flex flex-col items-center">
              <span className={`flex size-6 items-center justify-center rounded-full border bg-background ${presentation.tone}`}>
                <Icon className="size-3.5" aria-hidden="true" />
              </span>
              {index < activities.length - 1 ? (
                <span className="mt-1 h-full w-px bg-border" aria-hidden="true" />
              ) : null}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="break-all font-mono text-xs font-normal text-foreground">
                  {activity.name}
                </p>
                <span className={`text-xs font-medium ${presentation.tone}`}>
                  {presentation.label}
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-secondary">
                {presentation.detail}
              </p>
              <dl className="mt-3 grid gap-x-4 gap-y-2 font-mono text-[10px] leading-4 text-tertiary sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="uppercase tracking-[0.1em]">服务</dt>
                  <dd className="break-all text-secondary">{activity.serverId}</dd>
                </div>
                <div>
                  <dt className="uppercase tracking-[0.1em]">参数</dt>
                  <dd className="text-secondary">{activity.argumentsBytes} 字节</dd>
                </div>
                <div className="min-w-0 sm:col-span-2">
                  <dt className="uppercase tracking-[0.1em]">参数凭据</dt>
                  <dd className="break-all">{activity.argumentsSha256}</dd>
                </div>
                {activity.receipt?.type === 'completed' ? (
                  <>
                    <div>
                      <dt className="uppercase tracking-[0.1em]">保留结果</dt>
                      <dd className="text-secondary">
                        {activity.receipt.retainedBytes} 字节
                        {activity.receipt.truncated ? ' · 已截断' : ''}
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-[0.1em]">内容块</dt>
                      <dd className="text-secondary">
                        {activity.receipt.contentBlocks}
                        {activity.receipt.structuredContent ? ' · 结构化内容' : ''}
                      </dd>
                    </div>
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="uppercase tracking-[0.1em]">结果凭据</dt>
                      <dd className="break-all">{activity.receipt.sha256}</dd>
                    </div>
                  </>
                ) : activity.receipt?.type === 'error' ? (
                  <>
                    <div>
                      <dt className="uppercase tracking-[0.1em]">错误类型</dt>
                      <dd className="break-all text-secondary">{activity.receipt.kind}</dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-[0.1em]">请求状态</dt>
                      <dd className="break-all text-secondary">{activity.receipt.requestState}</dd>
                    </div>
                  </>
                ) : null}
              </dl>
            </div>
          </li>
        );
      })}
    </ol>
  </section>
);
