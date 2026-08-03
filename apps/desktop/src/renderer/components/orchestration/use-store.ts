import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { AgentTaskViewModel } from './types';

type ContextRailTab = 'workspace' | 'agent';

type OrchestrationStore = Readonly<{
  activeTab: ContextRailTab;
  selectedTask: AgentTaskViewModel | null;
  selectTask: (task: AgentTaskViewModel) => void;
  refreshTask: (task: AgentTaskViewModel) => void;
  setActiveTab: (tab: ContextRailTab) => void;
}>;

const OrchestrationContext = createContext<OrchestrationStore | null>(null);

export const OrchestrationStoreProvider = ({
  children,
}: Readonly<{
  children: ReactNode;
}>) => {
  const [activeTab, setActiveTab] = useState<ContextRailTab>('workspace');
  const [selectedTask, setSelectedTask] =
    useState<AgentTaskViewModel | null>(null);

  const selectTask = useCallback(
    (task: AgentTaskViewModel) => {
      setSelectedTask(task);
      setActiveTab('agent');
    },
    [],
  );

  const refreshTask = useCallback((task: AgentTaskViewModel) => {
    setSelectedTask((current) =>
      current?.taskId === task.taskId && current !== task ? task : current,
    );
  }, []);

  const value = useMemo<OrchestrationStore>(
    () => ({
      activeTab,
      selectedTask,
      selectTask,
      refreshTask,
      setActiveTab,
    }),
    [activeTab, refreshTask, selectTask, selectedTask],
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
