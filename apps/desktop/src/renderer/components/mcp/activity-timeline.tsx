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
    label: 'Awaiting approval',
    detail: 'No execution attempt is recorded.',
    Icon: CircleDashed,
    tone: 'text-process',
  },
  denied: {
    label: 'Denied',
    detail: 'The durable decision refused this call.',
    Icon: Ban,
    tone: 'text-destructive',
  },
  approved: {
    label: 'Approved',
    detail: 'The call is queued; no attempt is recorded yet.',
    Icon: ShieldCheck,
    tone: 'text-process',
  },
  attempted: {
    label: 'Attempt recorded',
    detail: 'Execution may have started; the outcome is pending.',
    Icon: CircleDashed,
    tone: 'text-process',
  },
  succeeded: {
    label: 'Completed',
    detail: 'A durable MCP result receipt was recorded.',
    Icon: Check,
    tone: 'text-foreground',
  },
  toolError: {
    label: 'Tool reported an error',
    detail: 'The server completed the call with isError true.',
    Icon: TriangleAlert,
    tone: 'text-destructive',
  },
  failed: {
    label: 'Call failed',
    detail: 'A stable transport or protocol error was recorded.',
    Icon: TriangleAlert,
    tone: 'text-destructive',
  },
  stopped: {
    label: 'Stopped',
    detail: 'The Turn ended before a complete result was recorded.',
    Icon: Ban,
    tone: 'text-secondary',
  },
  uncertain: {
    label: 'Outcome unknown',
    detail: 'An attempt exists without a durable result receipt.',
    Icon: CircleHelp,
    tone: 'text-destructive',
  },
};

export const McpActivityTimeline = ({
  activities,
}: McpActivityTimelineProps) => (
  <section
    className="ml-0 rounded-xl border bg-surface/55 sm:ml-10"
    aria-label={`${activities.length} MCP tool ${activities.length === 1 ? 'call' : 'calls'}`}
  >
    <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
      <div className="flex items-center gap-2">
        <PlugZap className="size-4 text-tertiary" aria-hidden="true" />
        <h3 className="text-sm font-medium">MCP activity</h3>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-tertiary">
        {activities.length}/4 calls
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
                  <dt className="uppercase tracking-[0.1em]">Server</dt>
                  <dd className="break-all text-secondary">{activity.serverId}</dd>
                </div>
                <div>
                  <dt className="uppercase tracking-[0.1em]">Arguments</dt>
                  <dd className="text-secondary">{activity.argumentsBytes} bytes</dd>
                </div>
                <div className="min-w-0 sm:col-span-2">
                  <dt className="uppercase tracking-[0.1em]">Arguments receipt</dt>
                  <dd className="break-all">{activity.argumentsSha256}</dd>
                </div>
                {activity.receipt?.type === 'completed' ? (
                  <>
                    <div>
                      <dt className="uppercase tracking-[0.1em]">Retained result</dt>
                      <dd className="text-secondary">
                        {activity.receipt.retainedBytes} bytes
                        {activity.receipt.truncated ? ' · truncated' : ''}
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-[0.1em]">Blocks</dt>
                      <dd className="text-secondary">
                        {activity.receipt.contentBlocks}
                        {activity.receipt.structuredContent ? ' · structured' : ''}
                      </dd>
                    </div>
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="uppercase tracking-[0.1em]">Result receipt</dt>
                      <dd className="break-all">{activity.receipt.sha256}</dd>
                    </div>
                  </>
                ) : activity.receipt?.type === 'error' ? (
                  <>
                    <div>
                      <dt className="uppercase tracking-[0.1em]">Error kind</dt>
                      <dd className="break-all text-secondary">{activity.receipt.kind}</dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-[0.1em]">Request state</dt>
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
