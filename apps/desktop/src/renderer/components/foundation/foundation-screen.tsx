import {
  CommandApprovalModeControl,
  CommandApprovalView,
} from '@/renderer/components/command-approval/command-approval-surface';
import { useStore as useCommandApprovalStore } from '@/renderer/components/command-approval/use-store';
import { McpApprovalSurface } from '@/renderer/components/mcp/approval-surface';
import { useStore as useMcpStore } from '@/renderer/components/mcp/use-store';
import { SettingsDialog } from '@/renderer/components/settings/settings-dialog';
import { ThreadWorkbenchView } from '@/renderer/components/thread/thread-workbench';
import { useStore as useThreadStore } from '@/renderer/components/thread/use-store';
import { OrchestrationStoreProvider } from '@/renderer/components/orchestration/use-store';
import { UpdateAction } from '@/renderer/components/update/update-action';
import { isApprovalVisibleForThread } from '@/renderer/utils/approval-visibility';

import { ContextRail } from './context-rail';
import { useStore } from './use-store';

export const FoundationScreen = () => {
  const foundation = useStore();
  const threadStore = useThreadStore();
  const commandApprovalStore = useCommandApprovalStore();
  const mcpStore = useMcpStore();
  const activeThreadId = threadStore.thread.threadIdentity;
  const activeCommandApproval = commandApprovalStore.requests.find(
    (request) =>
      isApprovalVisibleForThread(request.threadId, activeThreadId),
  );
  const approvalThreadIds = Array.from(
    new Set(
      [
        ...commandApprovalStore.requests.map((request) => request.threadId),
        ...mcpStore.approvalRequests.map((request) => request.threadId),
      ].filter((threadId): threadId is string => threadId !== undefined),
    ),
  );
  const turnBusy =
    threadStore.thread.phase === 'starting' ||
    threadStore.thread.phase === 'inProgress' ||
    threadStore.thread.phase === 'stopping';

  return (
    <div
      className={`flex h-screen min-h-120 flex-col overflow-hidden bg-background text-foreground ${
        foundation.isDark ? 'dark' : ''
      }`}
    >
      <OrchestrationStoreProvider
        scopeKey={activeThreadId}
        onRequestOpen={foundation.openContextRail}
      >
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
                workspaceId={threadStore.thread.workspaceIdentity}
                disabled={turnBusy}
              />
            }
            approvalSurface={
              activeCommandApproval ? (
                <CommandApprovalView
                  store={commandApprovalStore}
                  activeThreadId={activeThreadId}
                />
              ) : undefined
            }
            navigationFooter={
              <div className="space-y-1">
                <UpdateAction />
                <SettingsDialog
                  isDark={foundation.isDark}
                  themeLabel={foundation.themeLabel}
                  toggleTheme={foundation.toggleTheme}
                />
              </div>
            }
            contextRail={<ContextRail />}
            approvalThreadIds={approvalThreadIds}
          />
        </main>
      </OrchestrationStoreProvider>
      <McpApprovalSurface
        store={mcpStore}
        activeThreadId={activeThreadId}
      />
    </div>
  );
};
