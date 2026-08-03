import {
  CommandApprovalModeControl,
  CommandApprovalView,
} from '@/renderer/components/command-approval/command-approval-surface';
import { useStore as useCommandApprovalStore } from '@/renderer/components/command-approval/use-store';
import { ConnectionStatusBar } from '@/renderer/components/connection/connection-status';
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
  const commandApprovalStore = useCommandApprovalStore();
  const turnBusy =
    threadStore.thread.phase === 'starting' ||
    threadStore.thread.phase === 'inProgress' ||
    threadStore.thread.phase === 'stopping';

  return (
    <div
      className={`flex h-screen min-h-[30rem] flex-col overflow-hidden bg-background text-foreground ${
        foundation.isDark ? 'dark' : ''
      }`}
    >
      <OrchestrationStoreProvider>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <ThreadWorkbenchView
            store={threadStore}
            navigatorOpen={foundation.navigatorOpen}
            navigatorResize={foundation.navigatorResize}
            contextRailOpen={foundation.contextRailOpen}
            contextRailResize={foundation.contextRailResize}
            onToggleNavigator={foundation.toggleNavigator}
            onToggleContextRail={foundation.toggleContextRail}
            permissionControl={
              <CommandApprovalModeControl
                store={commandApprovalStore}
                threadId={threadStore.thread.threadIdentity}
                disabled={turnBusy}
              />
            }
            navigationFooter={
              <SettingsDialog
                isDark={foundation.isDark}
                themeLabel={foundation.themeLabel}
                turnBusy={turnBusy}
                toggleTheme={foundation.toggleTheme}
              />
            }
            contextRail={<ContextRail />}
          />
        </main>
      </OrchestrationStoreProvider>
      <ConnectionStatusBar />
      <CommandApprovalView store={commandApprovalStore} />
      <McpApprovalSurface />
    </div>
  );
};
