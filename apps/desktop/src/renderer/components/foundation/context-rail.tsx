import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { ConnectionStatus } from '@/renderer/components/connection/connection-status';
import { AgentDetail } from '@/renderer/components/orchestration/agent-detail';
import { useOrchestrationStore } from '@/renderer/components/orchestration/use-store';
import { Button } from '@/renderer/components/ui/button';
import { GitWorkbench } from '@/renderer/components/workspace/git/git-workbench';
import { PreviewWorkbench } from '@/renderer/components/workspace/preview/preview-workbench';
import { TerminalWorkbench } from '@/renderer/components/workspace/terminal/terminal-workbench';
import { WorkspaceWorkbench } from '@/renderer/components/workspace/workbench/workspace-workbench';

type ContextRailProps = Readonly<{
  onClose: () => void;
}>;

const RailAction = ({
  label,
  children,
}: Readonly<{
  label: string;
  children: ReactNode;
}>) => (
  <div
    className="rounded-lg px-1 py-0.5 transition-colors hover:bg-surface [&>button]:h-8 [&>button]:w-full [&>button]:max-w-none [&>button]:justify-start [&>button]:border-0 [&>button]:bg-transparent [&>button]:px-2 [&>button]:shadow-none"
    aria-label={label}
  >
    {children}
  </div>
);

export const ContextRail = ({ onClose }: ContextRailProps) => {
  const { activeTab, selectedTask, setActiveTab } =
    useOrchestrationStore();

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex h-14 shrink-0 items-center border-b px-3">
        <div
          className="flex h-8 items-center rounded-lg bg-surface p-0.5"
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
              {tab === 'workspace' ? 'Workspace' : 'Agent'}
            </button>
          ))}
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="ml-auto xl:hidden"
          onClick={onClose}
          aria-label="Close context rail"
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      {activeTab === 'workspace' ? (
        <>
          <div className="border-b p-3">
            <ConnectionStatus />
          </div>

          <section
            className="px-2 py-3"
            aria-labelledby="workspace-actions-title"
          >
            <p
              id="workspace-actions-title"
              className="px-2 pb-2 font-mono text-[9px] uppercase tracking-[0.16em] text-tertiary"
            >
              Tools
            </p>
            <div className="space-y-1">
              <RailAction label="Workspace explorer">
                <WorkspaceWorkbench />
              </RailAction>
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

          <p className="mt-auto border-t px-4 py-3 text-[11px] leading-4 text-tertiary">
            Files, Git, preview, and terminal remain local to the selected
            workspace.
          </p>
        </>
      ) : (
        <AgentDetail task={selectedTask} />
      )}
    </div>
  );
};
