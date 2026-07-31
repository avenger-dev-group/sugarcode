import { CommandApprovalSurface } from '@/renderer/components/command-approval/command-approval-surface';
import { McpApprovalSurface } from '@/renderer/components/mcp/approval-surface';
import { SettingsDialog } from '@/renderer/components/settings/settings-dialog';
import { ThreadWorkbenchView } from '@/renderer/components/thread/thread-workbench';
import { useStore as useThreadStore } from '@/renderer/components/thread/use-store';
import { OrchestrationStoreProvider } from '@/renderer/components/orchestration/use-store';

import { ContextRail } from './context-rail';
import { useStore } from './use-store';

export const FoundationScreen = () => {
  const foundation = useStore();
  const threadStore = useThreadStore();
  const turnBusy =
    threadStore.thread.phase === 'starting' ||
    threadStore.thread.phase === 'inProgress' ||
    threadStore.thread.phase === 'stopping';

  return (
    <div className={foundation.isDark ? 'dark' : undefined}>
      <OrchestrationStoreProvider
        onTaskSelected={() => foundation.setContextRailOpen(true)}
      >
        <main className="flex h-screen min-h-[30rem] min-w-0 flex-col overflow-hidden bg-background text-foreground">
          <ThreadWorkbenchView
            store={threadStore}
            contextRailOpen={foundation.contextRailOpen}
            setContextRailOpen={foundation.setContextRailOpen}
            navigationFooter={
              <SettingsDialog
                isDark={foundation.isDark}
                themeLabel={foundation.themeLabel}
                turnBusy={turnBusy}
                toggleTheme={foundation.toggleTheme}
              />
            }
            contextRail={
              <ContextRail
                onClose={() => foundation.setContextRailOpen(false)}
              />
            }
          />
        </main>
      </OrchestrationStoreProvider>
      <CommandApprovalSurface />
      <McpApprovalSurface />
    </div>
  );
};
