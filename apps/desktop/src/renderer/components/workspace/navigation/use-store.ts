import { useEffect, useState } from 'react';

import {
  activateWorkspaceChat,
  getWorkspaceState,
  onWorkspaceStateChanged,
  resumeWorkspaceProject,
  selectWorkspace,
} from '@/renderer/services/workspace';
import type { WorkspaceStateSnapshot } from '@/shared/workspace';

import type { WorkspaceNavigationStore } from './types';

const INITIAL_STATE: WorkspaceStateSnapshot = {
  revision: 0,
  generation: 0,
  status: 'unselected',
};

export const useStore = (): WorkspaceNavigationStore => {
  const [state, setState] = useState<WorkspaceStateSnapshot>(INITIAL_STATE);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const update = (snapshot: WorkspaceStateSnapshot): void => {
      if (!active) {
        return;
      }
      setState(snapshot);
      setError(snapshot.error ?? null);
    };
    const unsubscribe = onWorkspaceStateChanged(update);
    void getWorkspaceState().then(update).catch(() => {
      if (active) {
        setError('无法读取当前项目状态。');
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const runSelection = async (
    action: () => ReturnType<typeof selectWorkspace>,
    failure: string,
  ): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      const result = await action();
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
    error,
    chooseProject: () =>
      runSelection(selectWorkspace, '无法打开所选项目。'),
    resumeProject: () =>
      runSelection(resumeWorkspaceProject, '无法返回当前项目。'),
    activateChat: (threadId?: string) =>
      runSelection(
        () => activateWorkspaceChat(threadId),
        '无法打开聊天。',
      ),
  };
};
