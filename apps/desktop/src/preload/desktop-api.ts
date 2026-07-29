import type { IpcRendererEvent } from 'electron';

import {
  COMMAND_APPROVAL_APPROVE_CHANNEL,
  COMMAND_APPROVAL_DENY_CHANNEL,
  COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
  COMMAND_APPROVAL_STATE_GET_CHANNEL,
  isCommandApprovalActionResult,
  isCommandApprovalStateSnapshot,
  type CommandApprovalActionResult,
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
  CONVERSATION_SEND_CHANNEL,
  CONVERSATION_STATE_CHANGED_CHANNEL,
  CONVERSATION_STATE_GET_CHANNEL,
  CONVERSATION_STOP_CHANNEL,
  CONVERSATION_THREAD_SEARCH_CHANNEL,
  CONVERSATION_THREAD_SELECT_CHANNEL,
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
  isModelConfigInspection,
  MODEL_CONFIG_DELETE_CREDENTIAL_CHANNEL,
  MODEL_CONFIG_GET_CHANNEL,
  MODEL_CONFIG_RETRY_CONNECTION_CHANNEL,
  MODEL_CONFIG_SAVE_CHANNEL,
  type ModelConfigActionResult,
  type ModelConfigInspection,
  type ModelConfigSaveRequest,
} from '@/shared/model-config';
import {
  isWorkspaceInspectResult,
  isWorkspaceListResult,
  isWorkspaceSelectResult,
  isWorkspaceStateSnapshot,
  WORKSPACE_INSPECT_CHANNEL,
  WORKSPACE_LIST_CHANNEL,
  WORKSPACE_SELECT_CHANNEL,
  WORKSPACE_STATE_CHANGED_CHANNEL,
  WORKSPACE_STATE_GET_CHANNEL,
  type WorkspaceInspectRequest,
  type WorkspaceInspectResult,
  type WorkspaceListRequest,
  type WorkspaceListResult,
  type WorkspaceSelectResult,
  type WorkspaceStateSnapshot,
} from '@/shared/workspace';

type StateChangedHandler = (
  event: IpcRendererEvent,
  snapshot: unknown,
) => void;

export type IpcRendererBoundary = Readonly<{
  invoke: (channel: string, ...args: readonly unknown[]) => Promise<unknown>;
  on: (channel: string, listener: StateChangedHandler) => void;
  removeListener: (channel: string, listener: StateChangedHandler) => void;
}>;

export const createDesktopApi = (
  ipcRenderer: IpcRendererBoundary,
): DesktopApi => ({
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
  ): Promise<CommandApprovalActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      COMMAND_APPROVAL_APPROVE_CHANNEL,
      presentationId,
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
    input: string,
  ): Promise<ConversationActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      CONVERSATION_SEND_CHANNEL,
      input,
    );
    if (!isConversationActionResult(result)) {
      throw new Error('Main returned an invalid conversation send result.');
    }
    return result;
  },
  stopConversationTurn:
    async (): Promise<ConversationActionResult> => {
      const result: unknown = await ipcRenderer.invoke(
        CONVERSATION_STOP_CHANNEL,
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
  deleteModelCredential: async (
    expectedRevision: string,
  ): Promise<ModelConfigActionResult> => {
    const action: unknown = await ipcRenderer.invoke(
      MODEL_CONFIG_DELETE_CREDENTIAL_CHANNEL,
      expectedRevision,
    );
    if (!isModelConfigActionResult(action)) {
      throw new Error(
        'Main returned an invalid credential deletion action.',
      );
    }
    return action;
  },
  retryModelConnection:
    async (): Promise<ModelConfigActionResult> => {
      const action: unknown = await ipcRenderer.invoke(
        MODEL_CONFIG_RETRY_CONNECTION_CHANNEL,
      );
      if (!isModelConfigActionResult(action)) {
        throw new Error(
          'Main returned an invalid model reconnect action.',
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
