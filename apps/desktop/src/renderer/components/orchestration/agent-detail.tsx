import {
  Binoculars,
  ClipboardCheck,
  Clock3,
  FilePenLine,
  GitBranch,
  ShieldCheck,
} from 'lucide-react';

import { AgentMarkdown } from '@/renderer/components/agent/agent-markdown';

import type {
  AgentTaskRole,
  AgentTaskViewModel,
} from './types';
import { formatAgentTaskDuration } from './presentation';

const ROLE_LABELS: Record<AgentTaskRole, string> = {
  explorer: 'Explorer',
  worker: 'Worker',
  auditor: 'Auditor',
};

const STATUS_LABELS: Record<AgentTaskViewModel['status'], string> = {
  queued: 'Queued',
  running: 'Working',
  waitingApproval: 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};

const PROGRESS_LABELS: Record<
  NonNullable<AgentTaskViewModel['progress']>['stage'],
  string
> = {
  waitingForModel: 'Waiting for model',
  streaming: 'Streaming response',
  runningTool: 'Running tool',
};

const RoleIcon = ({ role }: Readonly<{ role: AgentTaskRole }>) => {
  switch (role) {
    case 'explorer':
      return <Binoculars aria-hidden="true" />;
    case 'worker':
      return <FilePenLine aria-hidden="true" />;
    case 'auditor':
      return <ShieldCheck aria-hidden="true" />;
  }
};

const DetailSection = ({
  title,
  children,
}: Readonly<{
  title: string;
  children: React.ReactNode;
}>) => (
  <section className="border-t px-4 py-4">
    <h3 className="mb-3 font-mono text-[9px] uppercase tracking-[0.16em] text-tertiary">
      {title}
    </h3>
    {children}
  </section>
);

export const AgentDetail = ({
  task,
}: Readonly<{ task: AgentTaskViewModel | null }>) => {
  if (!task) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center px-8 text-center">
        <GitBranch className="size-5 text-tertiary" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">Select an Agent node</p>
        <p className="mt-1 text-[13px] leading-5 text-secondary">
          Its frozen task brief, revisions, status, and public result will
          appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0 text-sm">
      <header className="px-4 pb-4 pt-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-surface [&>svg]:size-4">
            <RoleIcon role={task.role} />
          </span>
          <div className="min-w-0">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-tertiary">
              {ROLE_LABELS[task.role]} ·{' '}
              {task.access === 'readOnly' ? 'Read only' : 'Workspace write'}
            </p>
            <h2 className="mt-1 break-words text-sm font-medium leading-5">
              {task.title}
            </h2>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span
            className="rounded-full border bg-surface px-2 py-0.5 text-secondary"
            data-agent-status={task.status}
          >
            {STATUS_LABELS[task.status]}
          </span>
          {task.result ? (
            <span className="inline-flex items-center gap-1 text-tertiary">
              <Clock3 className="size-3" aria-hidden="true" />
              {formatAgentTaskDuration(task.result.durationMs)}
            </span>
          ) : null}
        </div>
      </header>

      <DetailSection title="Frozen task brief">
        <div className="text-[14px] font-normal leading-[21px]">
          <AgentMarkdown source={task.taskMarkdown} isStreaming={false} />
        </div>
      </DetailSection>

      {task.amendments.length > 0 ? (
        <DetailSection title={`Revisions · ${task.amendments.length}`}>
          <ol className="space-y-4">
            {task.amendments.map((amendment, index) => (
              <li key={amendment.id}>
                <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.14em] text-tertiary">
                  Revision {index + 1}
                </p>
                <div className="text-[14px] font-normal leading-[21px]">
                  <AgentMarkdown
                    source={amendment.markdown}
                    isStreaming={false}
                  />
                </div>
              </li>
            ))}
          </ol>
        </DetailSection>
      ) : null}

      {task.dependsOn.length > 0 ? (
        <DetailSection title="Dependencies">
          <ul className="space-y-1.5 text-[13px] text-secondary">
            {task.dependsOn.map((dependency) => (
              <li key={dependency} className="flex items-center gap-2">
                <GitBranch className="size-3 text-tertiary" aria-hidden="true" />
                <code className="break-all font-mono text-[11px]">
                  {dependency}
                </code>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      {task.progress && !task.result ? (
        <DetailSection title={`Live progress · ${PROGRESS_LABELS[task.progress.stage]}`}>
          <div
            className="text-[14px] font-normal leading-[21px]"
            aria-live="polite"
          >
            <AgentMarkdown
              source={task.progress.summaryMarkdown}
              isStreaming={task.progress.stage === 'streaming'}
            />
          </div>
        </DetailSection>
      ) : null}

      {task.result ? (
        <DetailSection
          title={
            task.status === 'failed'
              ? 'Failure details'
              : task.status === 'interrupted' || task.status === 'cancelled'
                ? 'Last recorded result'
                : task.role === 'auditor'
                  ? 'Auditor findings'
                  : 'Final summary'
          }
        >
          <div
            className={`text-[14px] font-normal leading-[21px] ${
              task.status === 'failed' ? 'text-destructive' : ''
            }`}
          >
            <AgentMarkdown
              source={task.result.summaryMarkdown}
              isStreaming={false}
            />
          </div>
        </DetailSection>
      ) : (
        <DetailSection title="Public activity">
          <p className="flex items-center gap-2 text-[13px] leading-5 text-secondary">
            <ClipboardCheck className="size-3.5" aria-hidden="true" />
            {task.status === 'queued'
              ? 'Waiting for dependencies.'
              : task.status === 'waitingApproval'
                ? 'A tool action needs your approval before this Agent can continue.'
                : task.status === 'running'
                  ? 'Agent is working. Its final public summary will appear here.'
                  : 'No public result was recorded.'}
          </p>
        </DetailSection>
      )}
    </div>
  );
};
