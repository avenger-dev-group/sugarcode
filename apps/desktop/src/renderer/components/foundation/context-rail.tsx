import type { ReactNode } from 'react';

import { AgentDetail } from '@/renderer/components/orchestration/agent-detail';
import { useOrchestrationStore } from '@/renderer/components/orchestration/use-store';
import { GitWorkbench } from '@/renderer/components/workspace/git/git-workbench';
import { PreviewWorkbench } from '@/renderer/components/workspace/preview/preview-workbench';
import { TerminalWorkbench } from '@/renderer/components/workspace/terminal/terminal-workbench';
import { WorkspaceWorkbench } from '@/renderer/components/workspace/workbench/workspace-workbench';

const RailAction = ({
  label,
  children,
}: Readonly<{
  label: string;
  children: ReactNode;
}>) => (
  <div
    className="min-w-0 flex-1 rounded-lg px-0.5 transition-colors hover:bg-surface [&>button]:h-8 [&>button]:w-full [&>button]:max-w-none [&>button]:justify-center [&>button]:border-0 [&>button]:bg-transparent [&>button]:px-1.5 [&>button]:shadow-none"
    aria-label={label}
  >
    {children}
  </div>
);

export const ContextRail = () => {
  const { activeTab, selectedTask, setActiveTab } =
    useOrchestrationStore();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="window-drag-region flex h-11 shrink-0 items-center border-b px-3">
        <div
          className="window-no-drag flex h-8 items-center rounded-lg bg-surface p-0.5"
          role="tablist"
          aria-label="Context rail"
        >
          {(['workspace', 'agent'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={`h-7 rounded-md px-3 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                activeTab === tab
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-secondary hover:text-foreground'
              }`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'workspace' ? '文件' : 'Agent'}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'workspace' ? (
        <>
          <div className="min-h-0 flex-1">
            <WorkspaceWorkbench />
          </div>
          <section className="shrink-0 border-t p-2" aria-label="项目工具">
            <div className="flex gap-1">
              <RailAction label="Git changes">
                <GitWorkbench />
              </RailAction>
              <RailAction label="Local preview">
                <PreviewWorkbench />
              </RailAction>
              <RailAction label="Local terminal">
                <TerminalWorkbench />
              </RailAction>
            </div>
          </section>
        </>
      ) : (
        <AgentDetail task={selectedTask} />
      )}
    </div>
  );
};
