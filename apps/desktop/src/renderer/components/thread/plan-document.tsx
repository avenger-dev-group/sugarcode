import { FileText } from 'lucide-react';

import { AgentMarkdown } from '@/renderer/components/agent/agent-markdown';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';

import type { ContextRailPlan } from '../orchestration/types';

export const PlanDocument = ({
  plan,
}: Readonly<{ plan: ContextRailPlan }>) => (
  <ScrollArea
    className="h-full min-h-0 min-w-0 max-w-full"
    viewportProps={{
      'aria-label': '完整计划内容',
      className:
        '[&>div]:!block [&>div]:w-full [&>div]:min-w-0 [&>div]:max-w-full',
      tabIndex: 0,
    }}
  >
    <article className="mx-auto w-full min-w-0 max-w-3xl px-6 pb-12 pt-7">
      <header className="mb-6 border-b border-border/80 pb-5">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-secondary">
          <span className="flex size-7 items-center justify-center rounded-lg bg-surface">
            <FileText className="size-3.5" aria-hidden="true" />
          </span>
          正式计划
        </div>
        <h2 className="text-xl font-medium tracking-[-0.02em]">完整计划</h2>
        <p className="mt-1 text-xs font-normal text-tertiary">
          来自当前任务的规划结果
        </p>
      </header>
      <AgentMarkdown source={plan.content} isStreaming={false} />
    </article>
  </ScrollArea>
);
