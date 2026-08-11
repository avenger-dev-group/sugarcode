import { useState } from 'react';
import { useStore as useZustandStore } from 'zustand';

import {
  activateWorkspaceChat,
  activateWorkspaceProject,
  deleteWorkspaceTask,
  focusWorkspaceTask,
  getWorkspaceState,
  removeWorkspaceProject,
  resumeWorkspaceProject,
  selectWorkspace,
} from '@/renderer/services/workspace';
import {
  acceptWorkspaceSnapshot,
  workspaceProjectionStore,
} from '@/renderer/stores/workspace-projection-store';
import {
  acceptForegroundCommit,
  beginConversationSelection,
  failConversationSelection,
} from '@/renderer/stores/conversation-projection-store';

import type { WorkspaceNavigationStore } from './types';

export const useStore = (): WorkspaceNavigationStore => {
  const state = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.snapshot,
  );
  const projectionError = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.loadError,
  );
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [failedChatThreadId, setFailedChatThreadId] = useState<string | null>(
    null,
  );

  const runSelection = async (
    action: () => ReturnType<typeof selectWorkspace>,
    failure: string,
  ): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (result.accepted && result.commit) {
        acceptWorkspaceSnapshot(result.commit.workspace);
        acceptForegroundCommit(result.commit);
      } else if (result.accepted) {
        await getWorkspaceState()
          .then(acceptWorkspaceSnapshot)
          .catch((): undefined => undefined);
      }
      if (!result.accepted && result.reason !== 'cancelled') {
        setError(
          result.reason === 'busy'
            ? '请先结束正在运行的任务，再切换项目。'
            : failure,
        );
      }
      return result.accepted;
    } catch {
      setError(failure);
      return false;
    } finally {
      setPending(false);
    }
  };

  return {
    state,
    busy: pending || state.status === 'selecting',
    error: error ?? projectionError,
    failedChatThreadId,
    chooseProject: () =>
      runSelection(selectWorkspace, '无法打开所选项目。'),
    resumeProject: () =>
      runSelection(resumeWorkspaceProject, '无法返回当前项目。'),
    activateProject: (projectId: string) =>
      runSelection(
        () => activateWorkspaceProject(projectId),
        '无法打开所选项目。',
      ),
    removeProject: (projectId: string) =>
      runSelection(
        () => removeWorkspaceProject(projectId),
        '无法从列表移除所选项目。',
      ),
    focusTask: async (threadId: string) => {
      beginConversationSelection(threadId);
      const accepted = await runSelection(
        () => focusWorkspaceTask(threadId),
        '无法打开所选会话。',
      );
      if (!accepted) {
        failConversationSelection(
          threadId,
          '无法打开所选会话。请重试。',
        );
      }
      return accepted;
    },
    activateChat: async (threadId?: string) => {
      const accepted = await runSelection(
        () => activateWorkspaceChat(threadId),
        '无法打开聊天。',
      );
      setFailedChatThreadId(accepted ? null : threadId ?? null);
      return accepted;
    },
    deleteTask: async (threadId: string) => {
      const accepted = await runSelection(
        () => deleteWorkspaceTask(threadId),
        '无法删除所选会话。',
      );
      if (accepted && failedChatThreadId === threadId) {
        setFailedChatThreadId(null);
      }
      return accepted;
    },
  };
};
