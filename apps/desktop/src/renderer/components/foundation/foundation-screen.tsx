import { Moon, Sun } from 'lucide-react';

import { ConnectionStatus } from '@/renderer/components/connection/connection-status';
import { CommandApprovalSurface } from '@/renderer/components/command-approval/command-approval-surface';
import { ThreadWorkbench } from '@/renderer/components/thread/thread-workbench';
import { Button } from '@/renderer/components/ui/button';
import { McpApprovalSurface } from '@/renderer/components/mcp/approval-surface';
import { ModelConfigWorkbench } from '@/renderer/components/model-config/model-config-workbench';
import { WorkspaceWorkbench } from '@/renderer/components/workspace/workbench/workspace-workbench';

import { useStore } from './use-store';

export const FoundationScreen = () => {
  const { isDark, themeLabel, toggleTheme } = useStore();

  return (
    <div className={isDark ? 'dark' : undefined}>
      <main className="flex h-screen min-h-[30rem] min-w-0 flex-col overflow-hidden bg-background text-foreground">
        <header className="relative z-10 grid min-h-20 min-w-0 grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 gap-y-2 border-b bg-background px-4 py-3 sm:flex sm:gap-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5 sm:min-w-32">
            <span
              className="size-2 rounded-full bg-primary"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-medium tracking-[-0.01em]">
                SugarCode
              </p>
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-tertiary">
                Desktop
              </p>
            </div>
          </div>

          <div className="col-span-4 row-start-2 min-w-0 w-full sm:col-auto sm:row-auto sm:ml-auto sm:max-w-xs">
            <ConnectionStatus />
          </div>

          <ModelConfigWorkbench />
          <WorkspaceWorkbench />

          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-pressed={isDark}
            aria-label={themeLabel}
            title={themeLabel}
            onClick={toggleTheme}
          >
            {isDark ? (
              <Sun aria-hidden="true" />
            ) : (
              <Moon aria-hidden="true" />
            )}
            <span className="sr-only">{themeLabel}</span>
          </Button>
        </header>
        <ThreadWorkbench />
      </main>
      <CommandApprovalSurface />
      <McpApprovalSurface />
    </div>
  );
};
