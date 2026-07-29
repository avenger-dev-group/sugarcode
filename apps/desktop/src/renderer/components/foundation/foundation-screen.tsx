import { Moon, Sun } from 'lucide-react';

import { ConnectionStatus } from '@/renderer/components/connection/connection-status';
import { CommandApprovalSurface } from '@/renderer/components/command-approval/command-approval-surface';
import { ThreadWorkbench } from '@/renderer/components/thread/thread-workbench';
import { Button } from '@/renderer/components/ui/button';
import { McpApprovalSurface } from '@/renderer/components/mcp/approval-surface';

import { useStore } from './use-store';

export const FoundationScreen = () => {
  const { isDark, themeLabel, toggleTheme } = useStore();

  return (
    <div className={isDark ? 'dark' : undefined}>
      <main className="flex h-screen min-h-[30rem] flex-col overflow-hidden bg-background text-foreground">
        <header className="relative z-10 flex min-h-20 items-center gap-4 border-b bg-background px-4 py-3 sm:px-6">
          <div className="flex min-w-32 items-center gap-2.5">
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

          <div className="ml-auto w-full max-w-xs">
            <ConnectionStatus />
          </div>

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
