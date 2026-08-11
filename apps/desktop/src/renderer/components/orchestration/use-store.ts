import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type {
  AgentTaskViewModel,
  ContextRailResource,
} from './types';

type ContextRailTab = 'workspace' | 'resource' | 'agent';

type OrchestrationStore = Readonly<{
  activeTab: ContextRailTab;
  selectedResource: ContextRailResource | null;
  selectedTask: AgentTaskViewModel | null;
  taskDockOpen: boolean;
  closeAgentTab: () => void;
  closeResourceTab: () => void;
  openDiff: (
    path: string,
    changes: readonly import('../workspace/types').FileChangeReviewFile[],
  ) => void;
  openFile: (path: string) => void;
  openSkill: (
    skill: Extract<ContextRailResource, { kind: 'skill' }>,
  ) => void;
  selectTask: (task: AgentTaskViewModel) => void;
  refreshTask: (task: AgentTaskViewModel) => void;
  setActiveTab: (tab: ContextRailTab) => void;
  setTaskDockOpen: (open: boolean) => void;
}>;

const OrchestrationContext = createContext<OrchestrationStore | null>(null);

export const OrchestrationStoreProvider = ({
  children,
  onRequestOpen,
  scopeKey,
}: Readonly<{
  children: ReactNode;
  onRequestOpen: () => void;
  scopeKey: string | null;
}>) => {
  const [activeTab, setActiveTab] = useState<ContextRailTab>('workspace');
  const [selectedTask, setSelectedTask] =
    useState<AgentTaskViewModel | null>(null);
  const [selectedResource, setSelectedResource] =
    useState<ContextRailResource | null>(null);
  const [taskDockOpen, setTaskDockOpen] = useState(false);

  const selectTask = useCallback(
    (task: AgentTaskViewModel) => {
      setSelectedTask(task);
      setTaskDockOpen(false);
      setActiveTab('agent');
      onRequestOpen();
    },
    [onRequestOpen],
  );

  const closeAgentTab = useCallback(() => {
    setSelectedTask(null);
    setActiveTab(selectedResource ? 'resource' : 'workspace');
  }, [selectedResource]);

  const closeResourceTab = useCallback(() => {
    setSelectedResource(null);
    setActiveTab(selectedTask ? 'agent' : 'workspace');
  }, [selectedTask]);

  const openFile = useCallback(
    (path: string) => {
      setSelectedResource({ kind: 'file', path });
      setActiveTab('resource');
      onRequestOpen();
    },
    [onRequestOpen],
  );

  const openDiff = useCallback(
    (
      path: string,
      changes: readonly import('../workspace/types').FileChangeReviewFile[],
    ) => {
      setSelectedResource({ kind: 'diff', path, changes });
      setActiveTab('resource');
      onRequestOpen();
    },
    [onRequestOpen],
  );

  const openSkill = useCallback(
    (skill: Extract<ContextRailResource, { kind: 'skill' }>) => {
      setSelectedResource(skill);
      setActiveTab('resource');
      onRequestOpen();
    },
    [onRequestOpen],
  );

  useEffect(() => {
    setSelectedTask(null);
    setSelectedResource(null);
    setTaskDockOpen(false);
    setActiveTab('workspace');
  }, [scopeKey]);

  const refreshTask = useCallback((task: AgentTaskViewModel) => {
    setSelectedTask((current) =>
      current?.taskId === task.taskId && current !== task ? task : current,
    );
  }, []);

  const value = useMemo<OrchestrationStore>(
    () => ({
      activeTab,
      closeAgentTab,
      closeResourceTab,
      openDiff,
      openFile,
      openSkill,
      selectedResource,
      selectedTask,
      selectTask,
      refreshTask,
      setActiveTab,
      setTaskDockOpen,
      taskDockOpen,
    }),
    [
      activeTab,
      closeAgentTab,
      closeResourceTab,
      openDiff,
      openFile,
      openSkill,
      refreshTask,
      selectTask,
      selectedResource,
      selectedTask,
      taskDockOpen,
    ],
  );

  return createElement(
    OrchestrationContext.Provider,
    { value },
    children,
  );
};

export const useOrchestrationStore = (): OrchestrationStore => {
  const store = useContext(OrchestrationContext);
  if (!store) {
    throw new Error(
      'useOrchestrationStore must be used inside OrchestrationStoreProvider.',
    );
  }
  return store;
};
