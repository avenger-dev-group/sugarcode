import type { IpcRendererEvent } from 'electron';

import {
  COMMAND_APPROVAL_APPROVE_CHANNEL,
  COMMAND_APPROVAL_DENY_CHANNEL,
  COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
  COMMAND_APPROVAL_STATE_GET_CHANNEL,
  COMMAND_APPROVAL_MODE_SET_CHANNEL,
  isCommandApprovalActionResult,
  isCommandApprovalStateSnapshot,
  type CommandApprovalActionResult,
  type CommandApprovalMode,
  type CommandApprovalStateSnapshot,
} from '@/shared/command-approval';
import {
  CONNECTION_STATE_CHANGED_CHANNEL,
  CONNECTION_STATE_GET_CHANNEL,
  isConnectionStateSnapshot,
  type ConnectionStateSnapshot,
} from '@/shared/connection';
import type { DesktopApi } from '@/shared/desktop-api';
import {
  GIT_COMMIT_CHANNEL,
  GIT_DIFF_CHANNEL,
  GIT_REFRESH_CHANNEL,
  GIT_STAGE_CHANNEL,
  GIT_STATE_CHANGED_CHANNEL,
  GIT_STATE_GET_CHANNEL,
  GIT_UNSTAGE_CHANNEL,
  isGitCommitResult,
  isGitDiffResult,
  isGitMutationResult,
  isGitRefreshResult,
  isGitStateSnapshot,
  type GitCommitRequest,
  type GitCommitResult,
  type GitDiffRequest,
  type GitDiffResult,
  type GitGenerationRequest,
  type GitMutationRequest,
  type GitMutationResult,
  type GitRefreshResult,
  type GitStateSnapshot,
} from '@/shared/git';
import {
  CONVERSATION_SEND_CHANNEL,
  CONVERSATION_STATE_CHANGED_CHANNEL,
  CONVERSATION_STATE_GET_CHANNEL,
  CONVERSATION_STOP_CHANNEL,
  CONVERSATION_THREAD_ARCHIVE_CHANNEL,
  CONVERSATION_THREAD_DELETE_CHANNEL,
  CONVERSATION_THREAD_FORK_CHANNEL,
  CONVERSATION_THREAD_NEW_CHANNEL,
  CONVERSATION_THREAD_SEARCH_CHANNEL,
  CONVERSATION_THREAD_SELECT_CHANNEL,
  CONVERSATION_THREAD_UNARCHIVE_CHANNEL,
  isConversationActionResult,
  isConversationStateSnapshot,
  type ConversationActionResult,
  type ConversationStateSnapshot,
} from '@/shared/conversation';
import {
  isMcpApprovalActionResult,
  isMcpApprovalStateSnapshot,
  isMcpConfigActionResult,
  isMcpConfigInspection,
  isMcpSessionActionResult,
  isMcpSessionStateSnapshot,
  MCP_APPROVAL_APPROVE_CHANNEL,
  MCP_APPROVAL_DENY_CHANNEL,
  MCP_APPROVAL_STATE_CHANGED_CHANNEL,
  MCP_APPROVAL_STATE_GET_CHANNEL,
  MCP_CONFIG_GET_CHANNEL,
  MCP_CONFIG_SAVE_CHANNEL,
  MCP_SESSION_DISABLE_CHANNEL,
  MCP_SESSION_ENABLE_CHANNEL,
  MCP_SESSION_STATE_CHANGED_CHANNEL,
  MCP_SESSION_STATE_GET_CHANNEL,
  MCP_SESSION_TOGGLE_CHANNEL,
  type McpApprovalActionResult,
  type McpApprovalStateSnapshot,
  type McpConfigActionResult,
  type McpConfigInspection,
  type McpConfigSaveRequest,
  type McpSessionActionResult,
  type McpSessionStateSnapshot,
} from '@/shared/mcp';
import {
  isModelConfigActionResult,
  isModelDiscoveryResult,
  isModelConfigInspection,
  MODEL_CONFIG_DELETE_API_KEY_CHANNEL,
  MODEL_CONFIG_DISCOVER_CHANNEL,
  MODEL_CONFIG_GET_CHANNEL,
  MODEL_CONFIG_SAVE_CHANNEL,
  type ModelConfigActionResult,
  type ModelConfigInspection,
  type ModelDiscoveryResult,
  type ModelConfigSaveRequest,
} from '@/shared/model-config';
import {
  isWorkspaceInspectResult,
  isWorkspaceListResult,
  isWorkspaceSelectResult,
  isWorkspaceStateSnapshot,
  WORKSPACE_CHAT_ACTIVATE_CHANNEL,
  WORKSPACE_INSPECT_CHANNEL,
  WORKSPACE_CLEAR_CHANNEL,
  WORKSPACE_LIST_CHANNEL,
  WORKSPACE_PROJECT_RESUME_CHANNEL,
  WORKSPACE_PROJECT_ACTIVATE_CHANNEL,
  WORKSPACE_SELECT_CHANNEL,
  WORKSPACE_STATE_CHANGED_CHANNEL,
  WORKSPACE_STATE_GET_CHANNEL,
  WORKSPACE_TASK_FOCUS_CHANNEL,
  type WorkspaceChatRequest,
  type WorkspaceInspectRequest,
  type WorkspaceInspectResult,
  type WorkspaceListRequest,
  type WorkspaceListResult,
  type WorkspaceSelectResult,
  type WorkspaceStateSnapshot,
} from '@/shared/workspace';
import {
  isPreviewActionResult,
  isPreviewStateSnapshot,
  PREVIEW_CLOSE_CHANNEL,
  PREVIEW_GO_BACK_CHANNEL,
  PREVIEW_GO_FORWARD_CHANNEL,
  PREVIEW_OPEN_CHANNEL,
  PREVIEW_RELOAD_CHANNEL,
  PREVIEW_SHOW_CHANNEL,
  PREVIEW_STATE_CHANGED_CHANNEL,
  PREVIEW_STATE_GET_CHANNEL,
  type PreviewActionResult,
  type PreviewOpenRequest,
  type PreviewSessionRequest,
  type PreviewStateSnapshot,
} from '@/shared/preview';
import {
  isTerminalActionResult,
  isTerminalStateSignal,
  isTerminalStateSnapshot,
  TERMINAL_CREATE_CHANNEL,
  TERMINAL_INPUT_CHANNEL,
  TERMINAL_RESIZE_CHANNEL,
  TERMINAL_STATE_CHANGED_CHANNEL,
  TERMINAL_STATE_GET_CHANNEL,
  TERMINAL_TERMINATE_CHANNEL,
  type TerminalActionResult,
  type TerminalCreateRequest,
  type TerminalInputRequest,
  type TerminalResizeRequest,
  type TerminalSessionRequest,
  type TerminalSnapshotRequest,
  type TerminalStateSnapshot,
} from '@/shared/terminal';

type StateChangedHandler = (
  event: IpcRendererEvent,
  snapshot: unknown,
) => void;

export type IpcRendererBoundary = Readonly<{
  invoke: (channel: string, ...args: readonly unknown[]) => Promise<unknown>;
  on: (channel: string, listener: StateChangedHandler) => void;
  removeListener: (channel: string, listener: StateChangedHandler) => void;
}>;

const invokeConversationThreadAction = async (
  ipcRenderer: IpcRendererBoundary,
  channel: string,
  threadId: string,
  action: string,
): Promise<ConversationActionResult> => {
  const result: unknown = await ipcRenderer.invoke(channel, threadId);
  if (!isConversationActionResult(result)) {
    throw new Error(
      `Main returned an invalid Thread ${action} result.`,
    );
  }
  return result;
};

export const createDesktopApi = (
  ipcRenderer: IpcRendererBoundary,
): DesktopApi => ({
  getTerminalSnapshot: async (
    request: TerminalSnapshotRequest,
  ): Promise<TerminalStateSnapshot> => {
    const snapshot: unknown = await ipcRenderer.invoke(
      TERMINAL_STATE_GET_CHANNEL,
      request,
    );
    if (!isTerminalStateSnapshot(snapshot)) {
      throw new Error('Main returned an invalid terminal state snapshot.');
    }
    return snapshot;
  },
  onTerminalStateChanged: (listener) => {
    const handler = (
      _event: IpcRendererEvent,
      signal: unknown,
    ): void => {
      if (isTerminalStateSignal(signal)) {
        listener(signal);
      }
    };
    ipcRenderer.on(TERMINAL_STATE_CHANGED_CHANNEL, handler);
    return () =>
      ipcRenderer.removeListener(TERMINAL_STATE_CHANGED_CHANNEL, handler);
  },
  createTerminal: (
    request: TerminalCreateRequest,
  ): Promise<TerminalActionResult> =>
    invokeTerminalAction(
      ipcRenderer,
      TERMINAL_CREATE_CHANNEL,
      request,
      'create',
    ),
  writeTerminalInput: (
    request: TerminalInputRequest,
  ): Promise<TerminalActionResult> =>
    invokeTerminalAction(
      ipcRenderer,
      TERMINAL_INPUT_CHANNEL,
      request,
      'input',
    ),
  resizeTerminal: (
    request: TerminalResizeRequest,
  ): Promise<TerminalActionResult> =>
    invokeTerminalAction(
      ipcRenderer,
      TERMINAL_RESIZE_CHANNEL,
      request,
      'resize',
    ),
  terminateTerminal: (
    request: TerminalSessionRequest,
  ): Promise<TerminalActionResult> =>
    invokeTerminalAction(
      ipcRenderer,
      TERMINAL_TERMINATE_CHANNEL,
      request,
      'terminate',
    ),
  getPreviewState: async (): Promise<PreviewStateSnapshot> => {
    const snapshot: unknown = await ipcRenderer.invoke(
      PREVIEW_STATE_GET_CHANNEL,
    );
    if (!isPreviewStateSnapshot(snapshot)) {
      throw new Error('Main returned an invalid preview state snapshot.');
    }
    return snapshot;
  },
  onPreviewStateChanged: (listener) => {
    const handler = (
      _event: IpcRendererEvent,
      snapshot: unknown,
    ): void => {
      if (isPreviewStateSnapshot(snapshot)) {
        listener(snapshot);
      }
    };
    ipcRenderer.on(PREVIEW_STATE_CHANGED_CHANNEL, handler);
    return () =>
      ipcRenderer.removeListener(PREVIEW_STATE_CHANGED_CHANNEL, handler);
  },
  openPreview: async (
    request: PreviewOpenRequest,
  ): Promise<PreviewActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      PREVIEW_OPEN_CHANNEL,
      request,
    );
    if (!isPreviewActionResult(result)) {
      throw new Error('Main returned an invalid preview open result.');
    }
    return result;
  },
  showPreview: (
    request: PreviewSessionRequest,
  ): Promise<PreviewActionResult> =>
    invokePreviewAction(ipcRenderer, PREVIEW_SHOW_CHANNEL, request, 'show'),
  reloadPreview: (
    request: PreviewSessionRequest,
  ): Promise<PreviewActionResult> =>
    invokePreviewAction(
      ipcRenderer,
      PREVIEW_RELOAD_CHANNEL,
      request,
      'reload',
    ),
  goBackPreview: (
    request: PreviewSessionRequest,
  ): Promise<PreviewActionResult> =>
    invokePreviewAction(
      ipcRenderer,
      PREVIEW_GO_BACK_CHANNEL,
      request,
      'back',
    ),
  goForwardPreview: (
    request: PreviewSessionRequest,
  ): Promise<PreviewActionResult> =>
    invokePreviewAction(
      ipcRenderer,
      PREVIEW_GO_FORWARD_CHANNEL,
      request,
      'forward',
    ),
  closePreview: (
    request: PreviewSessionRequest,
  ): Promise<PreviewActionResult> =>
    invokePreviewAction(
      ipcRenderer,
      PREVIEW_CLOSE_CHANNEL,
      request,
      'close',
    ),
  getGitState: async (): Promise<GitStateSnapshot> => {
    const snapshot: unknown = await ipcRenderer.invoke(
      GIT_STATE_GET_CHANNEL,
    );
    if (!isGitStateSnapshot(snapshot)) {
      throw new Error('Main returned an invalid Git state snapshot.');
    }
    return snapshot;
  },
  onGitStateChanged: (listener) => {
    const handler = (
      _event: IpcRendererEvent,
      snapshot: unknown,
    ): void => {
      if (isGitStateSnapshot(snapshot)) {
        listener(snapshot);
      }
    };
    ipcRenderer.on(GIT_STATE_CHANGED_CHANNEL, handler);
    return () =>
      ipcRenderer.removeListener(GIT_STATE_CHANGED_CHANNEL, handler);
  },
  refreshGitStatus: async (
    request: GitGenerationRequest,
  ): Promise<GitRefreshResult> => {
    const result: unknown = await ipcRenderer.invoke(
      GIT_REFRESH_CHANNEL,
      request,
    );
    if (!isGitRefreshResult(result)) {
      throw new Error('Main returned an invalid Git refresh result.');
    }
    return result;
  },
  loadGitDiff: async (
    request: GitDiffRequest,
  ): Promise<GitDiffResult> => {
    const result: unknown = await ipcRenderer.invoke(
      GIT_DIFF_CHANNEL,
      request,
    );
    if (!isGitDiffResult(result)) {
      throw new Error('Main returned an invalid Git diff result.');
    }
    return result;
  },
  stageGitPaths: async (
    request: GitMutationRequest,
  ): Promise<GitMutationResult> => {
    const result: unknown = await ipcRenderer.invoke(
      GIT_STAGE_CHANNEL,
      request,
    );
    if (!isGitMutationResult(result)) {
      throw new Error('Main returned an invalid Git stage result.');
    }
    return result;
  },
  unstageGitPaths: async (
    request: GitMutationRequest,
  ): Promise<GitMutationResult> => {
    const result: unknown = await ipcRenderer.invoke(
      GIT_UNSTAGE_CHANNEL,
      request,
    );
    if (!isGitMutationResult(result)) {
      throw new Error('Main returned an invalid Git unstage result.');
    }
    return result;
  },
  commitGitIndex: async (
    request: GitCommitRequest,
  ): Promise<GitCommitResult> => {
    const result: unknown = await ipcRenderer.invoke(
      GIT_COMMIT_CHANNEL,
      request,
    );
    if (!isGitCommitResult(result)) {
      throw new Error('Main returned an invalid Git commit result.');
    }
    return result;
  },
  getMcpConfig: async (): Promise<McpConfigInspection> => {
    const inspection: unknown = await ipcRenderer.invoke(
      MCP_CONFIG_GET_CHANNEL,
    );
    if (!isMcpConfigInspection(inspection)) {
      throw new Error('Main returned an invalid MCP configuration.');
    }
    return inspection;
  },
  saveMcpConfig: async (
    request: McpConfigSaveRequest,
  ): Promise<McpConfigActionResult> => {
    const action: unknown = await ipcRenderer.invoke(
      MCP_CONFIG_SAVE_CHANNEL,
      request,
    );
    if (!isMcpConfigActionResult(action)) {
      throw new Error('Main returned an invalid MCP configuration action.');
    }
    return action;
  },
  getConnectionState: async (): Promise<ConnectionStateSnapshot> => {
    const snapshot: unknown = await ipcRenderer.invoke(
      CONNECTION_STATE_GET_CHANNEL,
    );
    if (!isConnectionStateSnapshot(snapshot)) {
      throw new Error('Main returned an invalid connection state snapshot.');
    }
    return snapshot;
  },
  onConnectionStateChanged: (listener) => {
    const handleStateChanged = (
      _event: IpcRendererEvent,
      snapshot: unknown,
    ): void => {
      if (isConnectionStateSnapshot(snapshot)) {
        listener(snapshot);
      }
    };
    ipcRenderer.on(CONNECTION_STATE_CHANGED_CHANNEL, handleStateChanged);
    return () => {
      ipcRenderer.removeListener(
        CONNECTION_STATE_CHANGED_CHANNEL,
        handleStateChanged,
      );
    };
  },
  getCommandApprovalState:
    async (): Promise<CommandApprovalStateSnapshot> => {
      const snapshot: unknown = await ipcRenderer.invoke(
        COMMAND_APPROVAL_STATE_GET_CHANNEL,
      );
      if (!isCommandApprovalStateSnapshot(snapshot)) {
        throw new Error(
          'Main returned an invalid command approval state snapshot.',
        );
      }
      return snapshot;
    },
  onCommandApprovalStateChanged: (listener) => {
    const handleStateChanged = (
      _event: IpcRendererEvent,
      snapshot: unknown,
    ): void => {
      if (isCommandApprovalStateSnapshot(snapshot)) {
        listener(snapshot);
      }
    };
    ipcRenderer.on(
      COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
      handleStateChanged,
    );
    return () => {
      ipcRenderer.removeListener(
        COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
        handleStateChanged,
      );
    };
  },
  approveCommand: async (
    presentationId: string,
    mode: CommandApprovalMode,
  ): Promise<CommandApprovalActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      COMMAND_APPROVAL_APPROVE_CHANNEL,
      presentationId,
      mode,
    );
    if (!isCommandApprovalActionResult(result)) {
      throw new Error('Main returned an invalid command approval result.');
    }
    return result;
  },
  denyCommand: async (
    presentationId: string,
  ): Promise<CommandApprovalActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      COMMAND_APPROVAL_DENY_CHANNEL,
      presentationId,
    );
    if (!isCommandApprovalActionResult(result)) {
      throw new Error('Main returned an invalid command approval result.');
    }
    return result;
  },
  setCommandApprovalMode: async (
    mode: CommandApprovalMode,
    threadId?: string,
  ): Promise<CommandApprovalActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      COMMAND_APPROVAL_MODE_SET_CHANNEL,
      mode,
      threadId,
    );
    if (!isCommandApprovalActionResult(result)) {
      throw new Error('Main returned an invalid command approval mode result.');
    }
    return result;
  },
  getConversationState:
    async (): Promise<ConversationStateSnapshot> => {
      const snapshot: unknown = await ipcRenderer.invoke(
        CONVERSATION_STATE_GET_CHANNEL,
      );
      if (!isConversationStateSnapshot(snapshot)) {
        throw new Error(
          'Main returned an invalid conversation state snapshot.',
        );
      }
      return snapshot;
    },
  onConversationStateChanged: (listener) => {
    const handleStateChanged = (
      _event: IpcRendererEvent,
      snapshot: unknown,
    ): void => {
      if (isConversationStateSnapshot(snapshot)) {
        listener(snapshot);
      }
    };
    ipcRenderer.on(CONVERSATION_STATE_CHANGED_CHANNEL, handleStateChanged);
    return () => {
      ipcRenderer.removeListener(
        CONVERSATION_STATE_CHANGED_CHANNEL,
        handleStateChanged,
      );
    };
  },
  sendConversationMessage: async (
    request,
  ): Promise<ConversationActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      CONVERSATION_SEND_CHANNEL,
      request,
    );
    if (!isConversationActionResult(result)) {
      throw new Error('Main returned an invalid conversation send result.');
    }
    return result;
  },
  stopConversationTurn:
    async (threadId: string): Promise<ConversationActionResult> => {
      const result: unknown = await ipcRenderer.invoke(
        CONVERSATION_STOP_CHANNEL,
        threadId,
      );
      if (!isConversationActionResult(result)) {
        throw new Error('Main returned an invalid conversation stop result.');
      }
      return result;
    },
  searchConversationThreads: async (
    query: string,
  ): Promise<ConversationActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      CONVERSATION_THREAD_SEARCH_CHANNEL,
      query,
    );
    if (!isConversationActionResult(result)) {
      throw new Error('Main returned an invalid Thread search result.');
    }
    return result;
  },
  selectConversationThread: async (
    threadId: string,
  ): Promise<ConversationActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      CONVERSATION_THREAD_SELECT_CHANNEL,
      threadId,
    );
    if (!isConversationActionResult(result)) {
      throw new Error('Main returned an invalid Thread selection result.');
    }
    return result;
  },
  startNewConversationThread:
    async (): Promise<ConversationActionResult> => {
      const result: unknown = await ipcRenderer.invoke(
        CONVERSATION_THREAD_NEW_CHANNEL,
      );
      if (!isConversationActionResult(result)) {
        throw new Error('Main returned an invalid new Thread result.');
      }
      return result;
    },
  forkConversationThread: async (
    threadId: string,
  ): Promise<ConversationActionResult> =>
    invokeConversationThreadAction(
      ipcRenderer,
      CONVERSATION_THREAD_FORK_CHANNEL,
      threadId,
      'fork',
    ),
  archiveConversationThread: async (
    threadId: string,
  ): Promise<ConversationActionResult> =>
    invokeConversationThreadAction(
      ipcRenderer,
      CONVERSATION_THREAD_ARCHIVE_CHANNEL,
      threadId,
      'archive',
    ),
  unarchiveConversationThread: async (
    threadId: string,
  ): Promise<ConversationActionResult> =>
    invokeConversationThreadAction(
      ipcRenderer,
      CONVERSATION_THREAD_UNARCHIVE_CHANNEL,
      threadId,
      'unarchive',
    ),
  deleteConversationThread: async (
    threadId: string,
  ): Promise<ConversationActionResult> =>
    invokeConversationThreadAction(
      ipcRenderer,
      CONVERSATION_THREAD_DELETE_CHANNEL,
      threadId,
      'delete',
    ),
  getMcpSessionState: async (): Promise<McpSessionStateSnapshot> => {
    const snapshot: unknown = await ipcRenderer.invoke(
      MCP_SESSION_STATE_GET_CHANNEL,
    );
    if (!isMcpSessionStateSnapshot(snapshot)) {
      throw new Error('Main returned an invalid MCP session snapshot.');
    }
    return snapshot;
  },
  onMcpSessionStateChanged: (listener) => {
    const handler = (
      _event: IpcRendererEvent,
      snapshot: unknown,
    ): void => {
      if (isMcpSessionStateSnapshot(snapshot)) {
        listener(snapshot);
      }
    };
    ipcRenderer.on(MCP_SESSION_STATE_CHANGED_CHANNEL, handler);
    return () =>
      ipcRenderer.removeListener(MCP_SESSION_STATE_CHANGED_CHANNEL, handler);
  },
  toggleMcpServer: async (
    serverId: string,
  ): Promise<McpSessionActionResult> => {
    const action: unknown = await ipcRenderer.invoke(
      MCP_SESSION_TOGGLE_CHANNEL,
      serverId,
    );
    if (!isMcpSessionActionResult(action)) {
      throw new Error('Main returned an invalid MCP session action.');
    }
    return action;
  },
  enableMcpSession: async (): Promise<McpSessionActionResult> => {
    const action: unknown = await ipcRenderer.invoke(
      MCP_SESSION_ENABLE_CHANNEL,
    );
    if (!isMcpSessionActionResult(action)) {
      throw new Error('Main returned an invalid MCP session action.');
    }
    return action;
  },
  disableMcpSession: async (): Promise<McpSessionActionResult> => {
    const action: unknown = await ipcRenderer.invoke(
      MCP_SESSION_DISABLE_CHANNEL,
    );
    if (!isMcpSessionActionResult(action)) {
      throw new Error('Main returned an invalid MCP session action.');
    }
    return action;
  },
  getMcpApprovalState: async (): Promise<McpApprovalStateSnapshot> => {
    const snapshot: unknown = await ipcRenderer.invoke(
      MCP_APPROVAL_STATE_GET_CHANNEL,
    );
    if (!isMcpApprovalStateSnapshot(snapshot)) {
      throw new Error('Main returned an invalid MCP approval snapshot.');
    }
    return snapshot;
  },
  onMcpApprovalStateChanged: (listener) => {
    const handler = (
      _event: IpcRendererEvent,
      snapshot: unknown,
    ): void => {
      if (isMcpApprovalStateSnapshot(snapshot)) {
        listener(snapshot);
      }
    };
    ipcRenderer.on(MCP_APPROVAL_STATE_CHANGED_CHANNEL, handler);
    return () =>
      ipcRenderer.removeListener(
        MCP_APPROVAL_STATE_CHANGED_CHANNEL,
        handler,
      );
  },
  approveMcpCall: async (
    presentationId: string,
  ): Promise<McpApprovalActionResult> => {
    const action: unknown = await ipcRenderer.invoke(
      MCP_APPROVAL_APPROVE_CHANNEL,
      presentationId,
    );
    if (!isMcpApprovalActionResult(action)) {
      throw new Error('Main returned an invalid MCP approval action.');
    }
    return action;
  },
  denyMcpCall: async (
    presentationId: string,
  ): Promise<McpApprovalActionResult> => {
    const action: unknown = await ipcRenderer.invoke(
      MCP_APPROVAL_DENY_CHANNEL,
      presentationId,
    );
    if (!isMcpApprovalActionResult(action)) {
      throw new Error('Main returned an invalid MCP approval action.');
    }
    return action;
  },
  getModelConfig: async (): Promise<ModelConfigInspection> => {
    const inspection: unknown = await ipcRenderer.invoke(
      MODEL_CONFIG_GET_CHANNEL,
    );
    if (!isModelConfigInspection(inspection)) {
      throw new Error('Main returned an invalid model configuration.');
    }
    return inspection;
  },
  saveModelConfig: async (
    request: ModelConfigSaveRequest,
  ): Promise<ModelConfigActionResult> => {
    const action: unknown = await ipcRenderer.invoke(
      MODEL_CONFIG_SAVE_CHANNEL,
      request,
    );
    if (!isModelConfigActionResult(action)) {
      throw new Error(
        'Main returned an invalid model configuration action.',
      );
    }
    return action;
  },
  discoverModels: async (
    connectionId: string,
  ): Promise<ModelDiscoveryResult> => {
    const result: unknown = await ipcRenderer.invoke(
      MODEL_CONFIG_DISCOVER_CHANNEL,
      connectionId,
    );
    if (!isModelDiscoveryResult(result)) {
      throw new Error('Main returned an invalid model discovery result.');
    }
    return result;
  },
  deleteModelApiKey: async (
    connectionId: string,
    expectedRevision: string,
  ): Promise<ModelConfigActionResult> => {
    const action: unknown = await ipcRenderer.invoke(
      MODEL_CONFIG_DELETE_API_KEY_CHANNEL,
      connectionId,
      expectedRevision,
    );
    if (!isModelConfigActionResult(action)) {
      throw new Error(
        'Main returned an invalid credential deletion action.',
      );
    }
    return action;
  },
  getWorkspaceState: async (): Promise<WorkspaceStateSnapshot> => {
    const state: unknown = await ipcRenderer.invoke(
      WORKSPACE_STATE_GET_CHANNEL,
    );
    if (!isWorkspaceStateSnapshot(state)) {
      throw new Error('Main returned an invalid workspace state.');
    }
    return state;
  },
  onWorkspaceStateChanged: (listener) => {
    const handler = (
      _event: IpcRendererEvent,
      state: unknown,
    ): void => {
      if (isWorkspaceStateSnapshot(state)) {
        listener(state);
      }
    };
    ipcRenderer.on(WORKSPACE_STATE_CHANGED_CHANNEL, handler);
    return () =>
      ipcRenderer.removeListener(
        WORKSPACE_STATE_CHANGED_CHANNEL,
        handler,
      );
  },
  selectWorkspace: async (): Promise<WorkspaceSelectResult> => {
    const result: unknown = await ipcRenderer.invoke(
      WORKSPACE_SELECT_CHANNEL,
    );
    if (!isWorkspaceSelectResult(result)) {
      throw new Error('Main returned an invalid workspace selection result.');
    }
    return result;
  },
  resumeWorkspaceProject:
    async (): Promise<WorkspaceSelectResult> => {
      const result: unknown = await ipcRenderer.invoke(
        WORKSPACE_PROJECT_RESUME_CHANNEL,
      );
      if (!isWorkspaceSelectResult(result)) {
        throw new Error('Main returned an invalid project resume result.');
      }
      return result;
    },
  activateWorkspaceProject: async (
    projectId: string,
  ): Promise<WorkspaceSelectResult> => {
    const result: unknown = await ipcRenderer.invoke(
      WORKSPACE_PROJECT_ACTIVATE_CHANNEL,
      projectId,
    );
    if (!isWorkspaceSelectResult(result)) {
      throw new Error('Main returned an invalid project activation result.');
    }
    return result;
  },
  focusWorkspaceTask: async (
    threadId: string,
  ): Promise<WorkspaceSelectResult> => {
    const result: unknown = await ipcRenderer.invoke(
      WORKSPACE_TASK_FOCUS_CHANNEL,
      threadId,
    );
    if (!isWorkspaceSelectResult(result)) {
      throw new Error('Main returned an invalid task focus result.');
    }
    return result;
  },
  activateWorkspaceChat: async (
    request: WorkspaceChatRequest,
  ): Promise<WorkspaceSelectResult> => {
    const result: unknown = await ipcRenderer.invoke(
      WORKSPACE_CHAT_ACTIVATE_CHANNEL,
      request,
    );
    if (!isWorkspaceSelectResult(result)) {
      throw new Error('Main returned an invalid chat activation result.');
    }
    return result;
  },
  clearWorkspace: async (): Promise<WorkspaceSelectResult> => {
    const result: unknown = await ipcRenderer.invoke(
      WORKSPACE_CLEAR_CHANNEL,
    );
    if (!isWorkspaceSelectResult(result)) {
      throw new Error('Main returned an invalid workspace clear result.');
    }
    return result;
  },
  listWorkspace: async (
    request: WorkspaceListRequest,
  ): Promise<WorkspaceListResult> => {
    const result: unknown = await ipcRenderer.invoke(
      WORKSPACE_LIST_CHANNEL,
      request,
    );
    if (!isWorkspaceListResult(result)) {
      throw new Error('Main returned an invalid workspace list result.');
    }
    return result;
  },
  inspectWorkspace: async (
    request: WorkspaceInspectRequest,
  ): Promise<WorkspaceInspectResult> => {
    const result: unknown = await ipcRenderer.invoke(
      WORKSPACE_INSPECT_CHANNEL,
      request,
    );
    if (!isWorkspaceInspectResult(result)) {
      throw new Error('Main returned an invalid workspace inspect result.');
    }
    return result;
  },
});

const invokeTerminalAction = async (
  ipcRenderer: IpcRendererBoundary,
  channel: string,
  request:
    | TerminalCreateRequest
    | TerminalInputRequest
    | TerminalResizeRequest
    | TerminalSessionRequest,
  action: string,
): Promise<TerminalActionResult> => {
  const result: unknown = await ipcRenderer.invoke(channel, request);
  if (!isTerminalActionResult(result)) {
    throw new Error(`Main returned an invalid terminal ${action} result.`);
  }
  return result;
};

const invokePreviewAction = async (
  ipcRenderer: IpcRendererBoundary,
  channel: string,
  request: PreviewSessionRequest,
  action: string,
): Promise<PreviewActionResult> => {
  const result: unknown = await ipcRenderer.invoke(channel, request);
  if (!isPreviewActionResult(result)) {
    throw new Error(`Main returned an invalid preview ${action} result.`);
  }
  return result;
};
