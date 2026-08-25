import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type {
  AgentTaskViewModel,
  ContextRailPlan,
  ContextRailResource,
} from './types';
import {
  clearSelectedDrawioForSession,
  closeDrawioForSession,
  getSelectedDrawioPath,
  openDrawioForSession,
  type DrawioSessionRegistry,
} from './drawio-session-state';
import { hasRemainingContextTabs } from './context-tab-state';

export type BrowserContextTab = Readonly<{
  id: string;
  title: string;
}>;

export type ContextFileRequest = Readonly<{
  id: number;
  path: string;
}>;

type ContextRailTab =
  | 'launcher'
  | 'files'
  | 'resource'
  | 'plan'
  | 'agent'
  | `browser:${string}`;

type OrchestrationStore = Readonly<{
  activeTab: ContextRailTab;
  browserTabs: readonly BrowserContextTab[];
  filesTabOpen: boolean;
  requestedFile: ContextFileRequest | null;
  selectedPlan: ContextRailPlan | null;
  selectedResource: ContextRailResource | null;
  selectedTask: AgentTaskViewModel | null;
  taskDockOpen: boolean;
  closeAgentTab: () => void;
  closePlanTab: () => void;
  closeFilesTab: () => void;
  closePreviewTab: (id: string) => void;
  closeResourceTab: () => void;
  openDiff: (
    path: string,
    changes: readonly import('../workspace/types').FileChangeReviewFile[],
  ) => void;
  openDrawio: (path: string) => void;
  openFile: (path: string) => void;
  openPlan: (plan: ContextRailPlan) => void;
  openFiles: () => void;
  openPreview: (url?: string) => string;
  openSkill: (
    skill: Extract<ContextRailResource, { kind: 'skill' }>,
  ) => void;
  selectTask: (task: AgentTaskViewModel) => void;
  refreshTask: (task: AgentTaskViewModel) => void;
  setPreviewTitle: (id: string, title: string) => void;
  setActiveTab: (tab: ContextRailTab) => void;
  setTaskDockOpen: (open: boolean) => void;
}>;

type OrchestrationActions = Pick<
  OrchestrationStore,
  | 'openDiff'
  | 'openDrawio'
  | 'openFile'
  | 'openFiles'
  | 'openPlan'
  | 'openPreview'
  | 'openSkill'
  | 'refreshTask'
  | 'selectTask'
>;

type OrchestrationTaskState = Pick<
  OrchestrationStore,
  'selectedTask' | 'setTaskDockOpen' | 'taskDockOpen'
>;

const OrchestrationContext = createContext<OrchestrationStore | null>(null);
const OrchestrationActionsContext =
  createContext<OrchestrationActions | null>(null);
const OrchestrationTaskStateContext =
  createContext<OrchestrationTaskState | null>(null);

export const OrchestrationStoreProvider = ({
  children,
  onRequestClose,
  onRequestOpen,
  scopeKey,
}: Readonly<{
  children: ReactNode;
  onRequestClose: () => void;
  onRequestOpen: () => void;
  scopeKey: string | null;
}>) => {
  const drawioSessionsRef = useRef<DrawioSessionRegistry>(new Map());
  const drawioSessions = drawioSessionsRef.current;
  const restoredDrawioPath = getSelectedDrawioPath(drawioSessions, scopeKey);
  const [stateScopeKey, setStateScopeKey] = useState(scopeKey);
  const [activeTab, setActiveTab] = useState<ContextRailTab>(
    restoredDrawioPath ? 'resource' : 'launcher',
  );
  const [selectedTask, setSelectedTask] =
    useState<AgentTaskViewModel | null>(null);
  const [selectedResource, setSelectedResource] =
    useState<ContextRailResource | null>(
      restoredDrawioPath
        ? { kind: 'drawio', path: restoredDrawioPath }
        : null,
    );
  const [selectedPlan, setSelectedPlan] =
    useState<ContextRailPlan | null>(null);
  const [filesTabOpen, setFilesTabOpen] = useState(false);
  const [browserTabs, setBrowserTabs] = useState<
    readonly BrowserContextTab[]
  >([]);
  const browserTabsRef = useRef(browserTabs);
  browserTabsRef.current = browserTabs;
  const [requestedFile, setRequestedFile] =
    useState<ContextFileRequest | null>(null);
  const [taskDockOpen, setTaskDockOpen] = useState(false);
  const tabInventory = useMemo(
    () => ({
      files: filesTabOpen,
      browserCount: browserTabs.length,
      resource: selectedResource !== null,
      plan: selectedPlan !== null,
      agent: selectedTask !== null,
    }),
    [
      browserTabs.length,
      filesTabOpen,
      selectedPlan,
      selectedResource,
      selectedTask,
    ],
  );

  if (stateScopeKey !== scopeKey) {
    const nextDrawioPath = getSelectedDrawioPath(drawioSessions, scopeKey);
    setStateScopeKey(scopeKey);
    setActiveTab(nextDrawioPath ? 'resource' : 'launcher');
    setSelectedTask(null);
    setSelectedResource(
      nextDrawioPath ? { kind: 'drawio', path: nextDrawioPath } : null,
    );
    setSelectedPlan(null);
    setFilesTabOpen(false);
    setBrowserTabs([]);
    setRequestedFile(null);
    setTaskDockOpen(false);
  }

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
    setActiveTab((current) =>
      current === 'agent'
        ? selectedPlan
          ? 'plan'
          : selectedResource
            ? 'resource'
            : filesTabOpen
              ? 'files'
              : browserTabs.at(-1)
                ? `browser:${browserTabs.at(-1)?.id}`
                : 'launcher'
        : current,
    );
    if (!hasRemainingContextTabs(tabInventory, 'agent')) onRequestClose();
  }, [
    browserTabs,
    filesTabOpen,
    onRequestClose,
    selectedPlan,
    selectedResource,
    tabInventory,
  ]);

  const closeResourceTab = useCallback(() => {
    if (selectedResource?.kind === 'drawio') {
      closeDrawioForSession(
        drawioSessions,
        scopeKey,
        selectedResource.path,
      );
    }
    setSelectedResource(null);
    setActiveTab((current) =>
      current === 'resource'
        ? selectedPlan
          ? 'plan'
          : selectedTask
            ? 'agent'
            : filesTabOpen
              ? 'files'
              : browserTabs.at(-1)
                ? `browser:${browserTabs.at(-1)?.id}`
                : 'launcher'
        : current,
    );
    if (!hasRemainingContextTabs(tabInventory, 'resource')) onRequestClose();
  }, [
    browserTabs,
    drawioSessions,
    filesTabOpen,
    onRequestClose,
    scopeKey,
    selectedPlan,
    selectedResource,
    selectedTask,
    tabInventory,
  ]);

  const closePlanTab = useCallback(() => {
    setSelectedPlan(null);
    setActiveTab((current) =>
      current === 'plan'
        ? selectedResource
          ? 'resource'
          : selectedTask
            ? 'agent'
            : filesTabOpen
              ? 'files'
              : browserTabs.at(-1)
                ? `browser:${browserTabs.at(-1)?.id}`
                : 'launcher'
        : current,
    );
    if (!hasRemainingContextTabs(tabInventory, 'plan')) onRequestClose();
  }, [
    browserTabs,
    filesTabOpen,
    onRequestClose,
    selectedResource,
    selectedTask,
    tabInventory,
  ]);

  const openFile = useCallback(
    (path: string) => {
      setRequestedFile((current) => ({ id: (current?.id ?? 0) + 1, path }));
      setFilesTabOpen(true);
      setActiveTab('files');
      onRequestOpen();
    },
    [onRequestOpen],
  );

  const openDiff = useCallback(
    (
      path: string,
      changes: readonly import('../workspace/types').FileChangeReviewFile[],
    ) => {
      clearSelectedDrawioForSession(drawioSessions, scopeKey);
      setSelectedResource({ kind: 'diff', path, changes });
      setActiveTab('resource');
      onRequestOpen();
    },
    [drawioSessions, onRequestOpen, scopeKey],
  );

  const openDrawio = useCallback(
    (path: string) => {
      openDrawioForSession(drawioSessions, scopeKey, path);
      setSelectedResource({ kind: 'drawio', path });
      setActiveTab('resource');
      onRequestOpen();
    },
    [drawioSessions, onRequestOpen, scopeKey],
  );

  const openPlan = useCallback(
    (plan: ContextRailPlan) => {
      setSelectedPlan(plan);
      setActiveTab('plan');
      onRequestOpen();
    },
    [onRequestOpen],
  );

  const openFiles = useCallback(() => {
    setFilesTabOpen(true);
    setActiveTab('files');
    onRequestOpen();
  }, [onRequestOpen]);

  const openPreview = useCallback(
    (url?: string): string => {
      if (browserTabsRef.current.length >= 12) {
        const existing = browserTabsRef.current.at(-1);
        if (existing) {
          setActiveTab(`browser:${existing.id}`);
          onRequestOpen();
          return existing.id;
        }
      }
      const id = crypto.randomUUID();
      let title = '新标签页';
      if (url) {
        try {
          title = new URL(url).host;
        } catch {
          title = url.split(/[\\/]/u).at(-1) || '浏览器';
        }
      }
      setBrowserTabs((current) => [...current, { id, title }]);
      setActiveTab(`browser:${id}`);
      onRequestOpen();
      return id;
    },
    [onRequestOpen],
  );

  const closeFilesTab = useCallback(() => {
    setFilesTabOpen(false);
    setActiveTab((current) =>
      current === 'files'
        ? browserTabs.at(-1)
          ? `browser:${browserTabs.at(-1)?.id}`
          : 'launcher'
        : current,
    );
    if (!hasRemainingContextTabs(tabInventory, 'files')) onRequestClose();
  }, [browserTabs, onRequestClose, tabInventory]);

  const closePreviewTab = useCallback((id: string) => {
    setBrowserTabs((current) => current.filter((tab) => tab.id !== id));
    setActiveTab((current) => {
      if (current !== `browser:${id}`) {
        return current;
      }
      const remaining = browserTabs.filter((tab) => tab.id !== id);
      const next = remaining.at(-1);
      return next ? `browser:${next.id}` : filesTabOpen ? 'files' : 'launcher';
    });
    if (!hasRemainingContextTabs(tabInventory, 'browser')) onRequestClose();
  }, [browserTabs, filesTabOpen, onRequestClose, tabInventory]);

  const setPreviewTitle = useCallback((id: string, title: string) => {
    setBrowserTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        if (tab.id !== id || tab.title === title) {
          return tab;
        }
        changed = true;
        return { ...tab, title };
      });
      return changed ? next : current;
    });
  }, []);

  const openSkill = useCallback(
    (skill: Extract<ContextRailResource, { kind: 'skill' }>) => {
      clearSelectedDrawioForSession(drawioSessions, scopeKey);
      setSelectedResource(skill);
      setActiveTab('resource');
      onRequestOpen();
    },
    [drawioSessions, onRequestOpen, scopeKey],
  );

  const refreshTask = useCallback((task: AgentTaskViewModel) => {
    setSelectedTask((current) =>
      current?.taskId === task.taskId && current !== task ? task : current,
    );
  }, []);

  const value = useMemo<OrchestrationStore>(
    () => ({
      activeTab,
      browserTabs,
      closeAgentTab,
      closeFilesTab,
      closePlanTab,
      closePreviewTab,
      closeResourceTab,
      openDiff,
      openDrawio,
      openFile,
      openFiles,
      openPlan,
      openPreview,
      openSkill,
      filesTabOpen,
      requestedFile,
      selectedPlan,
      selectedResource,
      selectedTask,
      selectTask,
      refreshTask,
      setActiveTab,
      setPreviewTitle,
      setTaskDockOpen,
      taskDockOpen,
    }),
    [
      activeTab,
      browserTabs,
      closeAgentTab,
      closeFilesTab,
      closePlanTab,
      closePreviewTab,
      closeResourceTab,
      openDiff,
      openDrawio,
      openFile,
      openFiles,
      openPlan,
      openPreview,
      openSkill,
      filesTabOpen,
      requestedFile,
      refreshTask,
      selectTask,
      selectedPlan,
      selectedResource,
      selectedTask,
      setPreviewTitle,
      taskDockOpen,
    ],
  );

  const actions = useMemo<OrchestrationActions>(
    () => ({
      openDiff,
      openDrawio,
      openFile,
      openFiles,
      openPlan,
      openPreview,
      openSkill,
      refreshTask,
      selectTask,
    }),
    [
      openDiff,
      openDrawio,
      openFile,
      openFiles,
      openPlan,
      openPreview,
      openSkill,
      refreshTask,
      selectTask,
    ],
  );
  const taskState = useMemo<OrchestrationTaskState>(
    () => ({ selectedTask, setTaskDockOpen, taskDockOpen }),
    [selectedTask, taskDockOpen],
  );

  return createElement(
    OrchestrationActionsContext.Provider,
    { value: actions },
    createElement(
      OrchestrationTaskStateContext.Provider,
      { value: taskState },
      createElement(OrchestrationContext.Provider, { value }, children),
    ),
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

export const useOrchestrationActions = (): OrchestrationActions => {
  const actions = useContext(OrchestrationActionsContext);
  if (!actions) {
    throw new Error(
      'useOrchestrationActions must be used inside OrchestrationStoreProvider.',
    );
  }
  return actions;
};

export const useOrchestrationTaskState = (): OrchestrationTaskState => {
  const state = useContext(OrchestrationTaskStateContext);
  if (!state) {
    throw new Error(
      'useOrchestrationTaskState must be used inside OrchestrationStoreProvider.',
    );
  }
  return state;
};
