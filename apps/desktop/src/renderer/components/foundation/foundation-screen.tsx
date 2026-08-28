import {
  CommandApprovalModeControl,
  CommandApprovalView,
} from '@/renderer/components/command-approval/command-approval-surface';
import { CapabilityCenter } from '@/renderer/components/capabilities/capability-center';
import { useStore as useCommandApprovalStore } from '@/renderer/components/command-approval/use-store';
import { McpApprovalSurface } from '@/renderer/components/mcp/approval-surface';
import { useStore as useMcpStore } from '@/renderer/components/mcp/use-store';
import { SettingsDialog } from '@/renderer/components/settings/settings-dialog';
import { ThreadWorkbenchView } from '@/renderer/components/thread/thread-workbench';
import { GoalEditor } from '@/renderer/components/thread/goal-editor';
import { useStore as useThreadStore } from '@/renderer/components/thread/use-store';
import { OrchestrationStoreProvider } from '@/renderer/components/orchestration/use-store';
import { UpdateAction } from '@/renderer/components/update/update-action';
import { isApprovalVisibleForThread } from '@/renderer/utils/approval-visibility';
import { KnowledgeCenter } from '@/renderer/components/knowledge/knowledge-center';
import { GlobalSearch } from '@/renderer/components/search/global-search';
import { useEffect, useState } from 'react';

import { ContextRail } from './context-rail';
import { useStore } from './use-store';

export const FoundationScreen = () => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [knowledgeTargetId, setKnowledgeTargetId] = useState<string>();
  const [skillTargetId, setSkillTargetId] = useState<string>();
  const threadStore = useThreadStore();
  const activeThreadId = threadStore.thread.threadIdentity;
  const foundation = useStore(activeThreadId ?? null);
  const commandApprovalStore = useCommandApprovalStore();
  const mcpStore = useMcpStore();
  const activeCommandApproval = commandApprovalStore.requests.find(
    (request) =>
      isApprovalVisibleForThread(request.threadId, activeThreadId),
  );
  const activeMcpApproval = mcpStore.approvalRequests.find((request) =>
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        foundation.openSearch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [foundation.openSearch]);

  const openKnowledge = (knowledgeBaseId?: string): void => {
    setKnowledgeTargetId(knowledgeBaseId);
    foundation.setSurface('knowledge');
  };
  const openSkills = (skillId?: string): void => {
    setSkillTargetId(skillId);
    foundation.setSurface('capabilities');
  };

  return (
    <div
      className={`flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground ${
        foundation.isDark ? 'dark' : ''
      }`}
    >
      <OrchestrationStoreProvider
        scopeKey={activeThreadId}
        onRequestClose={foundation.closeContextRail}
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
              ) : activeMcpApproval ? (
                <McpApprovalSurface
                  store={mcpStore}
                  permissionStore={commandApprovalStore}
                  activeThreadId={activeThreadId}
                  activeWorkspaceId={threadStore.thread.workspaceIdentity}
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
                  workspaceId={threadStore.thread.workspaceIdentity}
                  threadId={threadStore.thread.threadIdentity}
                  open={settingsOpen}
                  onOpenChange={setSettingsOpen}
                />
              </div>
            }
            contextRail={
              <ContextRail
                goalEditor={threadStore.thread.goal ? (
                  <GoalEditor
                    goal={threadStore.thread.goal}
                    modelOptions={threadStore.modelOptions}
                    onMutate={threadStore.mutateGoal}
                  />
                ) : undefined}
                scopeKey={activeThreadId ?? null}
                visible={foundation.contextRailOpen}
              />
            }
            approvalThreadIds={approvalThreadIds}
            navigatorSurface={foundation.surface}
            onOpenSearch={foundation.openSearch}
            onOpenKnowledge={openKnowledge}
            onOpenSkills={openSkills}
            onOpenWorkbench={() => foundation.setSurface('workbench')}
            mainSurface={
              foundation.surface === 'knowledge' ? (
                <KnowledgeCenter
                  workspaceId={threadStore.thread.workspaceIdentity}
                  navigatorOpen={foundation.navigatorOpen}
                  initialKnowledgeBaseId={knowledgeTargetId}
                  onInitialKnowledgeBaseHandled={() => setKnowledgeTargetId(undefined)}
                />
              ) : foundation.surface === 'capabilities' ? (
                <CapabilityCenter
                  turnBusy={turnBusy}
                  initialSkillId={skillTargetId}
                  onInitialSkillHandled={() => setSkillTargetId(undefined)}
                />
              ) : undefined
            }
          />
        </main>
      </OrchestrationStoreProvider>
      <GlobalSearch
        open={foundation.searchOpen}
        onOpenChange={(open) => open ? foundation.openSearch() : foundation.closeSearch()}
        onOpenKnowledge={openKnowledge}
        onOpenSkills={openSkills}
        onOpenWorkbench={() => foundation.setSurface('workbench')}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    </div>
  );
};
