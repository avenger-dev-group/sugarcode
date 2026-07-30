import type { IpcRendererEvent } from 'electron';

import { describe, expect, it, vi } from 'vitest';

import {
  COMMAND_APPROVAL_APPROVE_CHANNEL,
  COMMAND_APPROVAL_DENY_CHANNEL,
  COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
  COMMAND_APPROVAL_STATE_GET_CHANNEL,
} from '@/shared/command-approval';
import {
  CONNECTION_STATE_CHANGED_CHANNEL,
  CONNECTION_STATE_GET_CHANNEL,
} from '@/shared/connection';
import {
  CONVERSATION_SEND_CHANNEL,
  CONVERSATION_STATE_CHANGED_CHANNEL,
  CONVERSATION_STATE_GET_CHANNEL,
  CONVERSATION_STOP_CHANNEL,
  CONVERSATION_THREAD_SEARCH_CHANNEL,
  CONVERSATION_THREAD_SELECT_CHANNEL,
  CONVERSATION_THREAD_ARCHIVE_CHANNEL,
  CONVERSATION_THREAD_DELETE_CHANNEL,
  CONVERSATION_THREAD_FORK_CHANNEL,
  CONVERSATION_THREAD_UNARCHIVE_CHANNEL,
  type ConversationStateSnapshot,
} from '@/shared/conversation';
import {
  MCP_CONFIG_GET_CHANNEL,
  MCP_CONFIG_SAVE_CHANNEL,
  type McpConfigInspection,
} from '@/shared/mcp';
import {
  MODEL_CONFIG_DELETE_CREDENTIAL_CHANNEL,
  MODEL_CONFIG_GET_CHANNEL,
  MODEL_CONFIG_RETRY_CONNECTION_CHANNEL,
  MODEL_CONFIG_SAVE_CHANNEL,
  type ModelConfigInspection,
} from '@/shared/model-config';
import {
  PREVIEW_CLOSE_CHANNEL,
  PREVIEW_OPEN_CHANNEL,
  PREVIEW_STATE_CHANGED_CHANNEL,
  PREVIEW_STATE_GET_CHANNEL,
} from '@/shared/preview';

import {
  createDesktopApi,
  type IpcRendererBoundary,
} from '../desktop-api';

const createIpcBoundary = () => {
  const listeners = new Map<
    string,
    (event: IpcRendererEvent, snapshot: unknown) => void
  >();
  const invoke = vi.fn();
  const on = vi.fn(
    (
      channel: string,
      listener: (event: IpcRendererEvent, snapshot: unknown) => void,
    ) => {
      listeners.set(channel, listener);
    },
  );
  const removeListener = vi.fn(
    (
      channel: string,
      listener: (event: IpcRendererEvent, snapshot: unknown) => void,
    ) => {
      if (listeners.get(channel) === listener) {
        listeners.delete(channel);
      }
    },
  );
  const ipc: IpcRendererBoundary = {
    invoke,
    on,
    removeListener,
  };
  return { ipc, invoke, listeners, on, removeListener };
};

describe('createDesktopApi', () => {
  it('uses fixed channels and validates snapshots', async () => {
    const boundary = createIpcBoundary();
    boundary.invoke.mockResolvedValue({ revision: 1, status: 'ready' });
    const api = createDesktopApi(boundary.ipc);

    await expect(api.getConnectionState()).resolves.toEqual({
      revision: 1,
      status: 'ready',
    });
    expect(boundary.invoke).toHaveBeenCalledWith(
      CONNECTION_STATE_GET_CHANNEL,
    );

    boundary.invoke.mockResolvedValue({ revision: -1, status: 'ready' });
    await expect(api.getConnectionState()).rejects.toThrow(
      'invalid connection state',
    );
  });

  it('validates model configuration receipts across the preload boundary', async () => {
    const boundary = createIpcBoundary();
    const api = createDesktopApi(boundary.ipc);
    const inspection: ModelConfigInspection = {
      contractVersion: 1,
      revision: 'a'.repeat(64),
      config: {
        apiFormat: 'openai-chat-completions',
        endpoint: 'http://127.0.0.1:18080/v1/chat/completions',
        model: 'fixture-model',
        credentialReference: 'model-api-token',
      },
      credentialStatus: 'present',
    };
    boundary.invoke.mockImplementation(async (channel: string) => {
      if (channel === MODEL_CONFIG_GET_CHANNEL) {
        return inspection;
      }
      return {
        accepted: true,
        state: 'active',
        inspection,
      };
    });

    await expect(api.getModelConfig()).resolves.toEqual(inspection);
    await expect(
      api.saveModelConfig({
        expectedRevision: inspection.revision,
        config: inspection.config,
      }),
    ).resolves.toMatchObject({ accepted: true, state: 'active' });
    await expect(
      api.deleteModelCredential(inspection.revision),
    ).resolves.toMatchObject({ accepted: true });
    await expect(api.retryModelConnection()).resolves.toMatchObject({
      accepted: true,
    });
    expect(boundary.invoke).toHaveBeenCalledWith(
      MODEL_CONFIG_SAVE_CHANNEL,
      expect.any(Object),
    );
    expect(boundary.invoke).toHaveBeenCalledWith(
      MODEL_CONFIG_DELETE_CREDENTIAL_CHANNEL,
      inspection.revision,
    );
    expect(boundary.invoke).toHaveBeenCalledWith(
      MODEL_CONFIG_RETRY_CONNECTION_CHANNEL,
    );

    boundary.invoke.mockResolvedValue({
      ...inspection,
      credentialStatus: 'backendError',
    });
    await expect(api.getModelConfig()).rejects.toThrow(
      'invalid model configuration',
    );
  });

  it('validates MCP registry receipts across the preload boundary', async () => {
    const boundary = createIpcBoundary();
    const api = createDesktopApi(boundary.ipc);
    const inspection: McpConfigInspection = {
      contractVersion: 1,
      revision: 'c'.repeat(64),
      servers: [
        {
          id: 'local-tools',
          transport: 'stdio',
          executable: '/usr/bin/local-tools',
          argv: ['serve'],
          cwd: '/tmp',
        },
      ],
    };
    boundary.invoke.mockImplementation(async (channel: string) =>
      channel === MCP_CONFIG_GET_CHANNEL
        ? inspection
        : { accepted: true, reason: 'accepted', inspection },
    );

    await expect(api.getMcpConfig()).resolves.toEqual(inspection);
    await expect(
      api.saveMcpConfig({
        expectedRevision: inspection.revision,
        servers: inspection.servers,
      }),
    ).resolves.toMatchObject({ accepted: true, reason: 'accepted' });
    expect(boundary.invoke).toHaveBeenCalledWith(
      MCP_CONFIG_SAVE_CHANNEL,
      expect.any(Object),
    );

    boundary.invoke.mockResolvedValue({
      ...inspection,
      servers: [{ ...inspection.servers[0], endpoint: 'https://remote.test' }],
    });
    await expect(api.getMcpConfig()).rejects.toThrow(
      'invalid MCP configuration',
    );
  });

  it('subscribes, filters invalid payloads, and unsubscribes exactly once', () => {
    const boundary = createIpcBoundary();
    const api = createDesktopApi(boundary.ipc);
    const listener = vi.fn();
    const unsubscribe = api.onConnectionStateChanged(listener);
    const handleStateChanged = boundary.listeners.get(
      CONNECTION_STATE_CHANGED_CHANNEL,
    );

    expect(handleStateChanged).toBeDefined();
    handleStateChanged?.(
      {} as IpcRendererEvent,
      { revision: 1, status: 'connecting' },
    );
    handleStateChanged?.(
      {} as IpcRendererEvent,
      { revision: 2, status: 'unknown' },
    );
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    expect(boundary.removeListener).toHaveBeenCalledWith(
      CONNECTION_STATE_CHANGED_CHANNEL,
      handleStateChanged,
    );
    expect(
      boundary.listeners.has(CONNECTION_STATE_CHANGED_CHANNEL),
    ).toBe(false);
  });

  it('validates the fixed preview boundary and filters state events', async () => {
    const boundary = createIpcBoundary();
    const api = createDesktopApi(boundary.ipc);
    const sessionId = '12345678-1234-4123-8123-123456789abc';
    boundary.invoke.mockImplementation(async (channel: string) => {
      if (channel === PREVIEW_STATE_GET_CHANNEL) {
        return { revision: 0, status: 'closed' };
      }
      return { accepted: true, reason: 'accepted' };
    });

    await expect(api.getPreviewState()).resolves.toEqual({
      revision: 0,
      status: 'closed',
    });
    await expect(
      api.openPreview({
        generation: 3,
        url: 'http://127.0.0.1:4173/',
      }),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(
      api.closePreview({ generation: 3, sessionId }),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    expect(boundary.invoke).toHaveBeenCalledWith(PREVIEW_OPEN_CHANNEL, {
      generation: 3,
      url: 'http://127.0.0.1:4173/',
    });
    expect(boundary.invoke).toHaveBeenCalledWith(PREVIEW_CLOSE_CHANNEL, {
      generation: 3,
      sessionId,
    });

    const listener = vi.fn();
    const unsubscribe = api.onPreviewStateChanged(listener);
    const handler = boundary.listeners.get(PREVIEW_STATE_CHANGED_CHANNEL);
    handler?.(
      {} as IpcRendererEvent,
      {
        revision: 1,
        status: 'ready',
        generation: 3,
        sessionId,
        url: 'http://127.0.0.1:4173/',
        origin: 'http://127.0.0.1:4173',
        visible: true,
        canGoBack: false,
        canGoForward: false,
      },
    );
    handler?.(
      {} as IpcRendererEvent,
      {
        revision: 2,
        status: 'ready',
        generation: 3,
        sessionId,
        url: 'https://remote.example/',
      },
    );
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(boundary.listeners.has(PREVIEW_STATE_CHANGED_CHANNEL)).toBe(
      false,
    );

    boundary.invoke.mockResolvedValue({
      accepted: true,
      reason: 'failed',
    });
    await expect(
      api.closePreview({ generation: 3, sessionId }),
    ).rejects.toThrow('invalid preview close result');
  });

  it('validates the bounded command approval API and unsubscribe path', async () => {
    const boundary = createIpcBoundary();
    const api = createDesktopApi(boundary.ipc);
    boundary.invoke.mockImplementation(
      async (channel: string, presentationId?: string) => {
        if (channel === COMMAND_APPROVAL_STATE_GET_CHANNEL) {
          return { revision: 0, status: 'idle' };
        }
        if (
          (channel === COMMAND_APPROVAL_APPROVE_CHANNEL ||
            channel === COMMAND_APPROVAL_DENY_CHANNEL) &&
          presentationId === 'presentation/one'
        ) {
          return { accepted: true, reason: 'accepted' };
        }
        return null;
      },
    );

    await expect(api.getCommandApprovalState()).resolves.toEqual({
      revision: 0,
      status: 'idle',
    });
    await expect(
      api.approveCommand('presentation/one'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(api.denyCommand('presentation/one')).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    expect(boundary.invoke).toHaveBeenCalledWith(
      COMMAND_APPROVAL_APPROVE_CHANNEL,
      'presentation/one',
    );
    expect(boundary.invoke).toHaveBeenCalledWith(
      COMMAND_APPROVAL_DENY_CHANNEL,
      'presentation/one',
    );

    const listener = vi.fn();
    const unsubscribe = api.onCommandApprovalStateChanged(listener);
    const handleStateChanged = boundary.listeners.get(
      COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
    );
    handleStateChanged?.(
      {} as IpcRendererEvent,
      { revision: 1, status: 'approved' },
    );
    handleStateChanged?.(
      {} as IpcRendererEvent,
      {
        revision: 2,
        status: 'pending',
        request: { presentationId: 'missing-required-fields' },
      },
    );
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(boundary.listeners.has(
      COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
    )).toBe(false);

    boundary.invoke.mockResolvedValue({
      accepted: true,
      reason: 'stale',
    });
    await expect(
      api.approveCommand('presentation/one'),
    ).rejects.toThrow('invalid command approval result');
  });

  it('exposes only the bounded conversation snapshot and actions', async () => {
    const boundary = createIpcBoundary();
    const api = createDesktopApi(boundary.ipc);
    const snapshot: ConversationStateSnapshot = {
      revision: 1,
      phase: 'ready',
      threadId: 'thr_0000000000000001',
      turns: [],
      navigator: {
        status: 'ready',
        activeThreadIds: ['thr_0000000000000001'],
        activeTruncated: false,
        search: {
          query: '',
          status: 'idle',
          threadIds: [],
          truncated: false,
        },
      },
    };
    boundary.invoke.mockImplementation(
      async (channel: string, input?: string) => {
        if (channel === CONVERSATION_STATE_GET_CHANNEL) {
          return snapshot;
        }
        if (
          channel === CONVERSATION_SEND_CHANNEL &&
          input === 'Exact input'
        ) {
          return { accepted: true, reason: 'accepted' };
        }
        if (channel === CONVERSATION_STOP_CHANNEL) {
          return { accepted: false, reason: 'noActiveTurn' };
        }
        if (
          channel === CONVERSATION_THREAD_SEARCH_CHANNEL ||
          channel === CONVERSATION_THREAD_SELECT_CHANNEL ||
          channel === CONVERSATION_THREAD_FORK_CHANNEL ||
          channel === CONVERSATION_THREAD_ARCHIVE_CHANNEL ||
          channel === CONVERSATION_THREAD_UNARCHIVE_CHANNEL ||
          channel === CONVERSATION_THREAD_DELETE_CHANNEL
        ) {
          return { accepted: true, reason: 'accepted' };
        }
        return null;
      },
    );

    await expect(api.getConversationState()).resolves.toEqual(snapshot);
    await expect(
      api.sendConversationMessage('Exact input'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(api.stopConversationTurn()).resolves.toEqual({
      accepted: false,
      reason: 'noActiveTurn',
    });
    await expect(
      api.searchConversationThreads('durable truth'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(
      api.selectConversationThread('thr_0000000000000001'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(
      api.forkConversationThread('thr_0000000000000001'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(
      api.archiveConversationThread('thr_0000000000000001'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(
      api.unarchiveConversationThread('thr_0000000000000001'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(
      api.deleteConversationThread('thr_0000000000000001'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    expect(boundary.invoke).toHaveBeenCalledWith(
      CONVERSATION_SEND_CHANNEL,
      'Exact input',
    );
    expect(boundary.invoke).toHaveBeenCalledWith(CONVERSATION_STOP_CHANNEL);
    expect(boundary.invoke).toHaveBeenCalledWith(
      CONVERSATION_THREAD_SEARCH_CHANNEL,
      'durable truth',
    );
    expect(boundary.invoke).toHaveBeenCalledWith(
      CONVERSATION_THREAD_SELECT_CHANNEL,
      'thr_0000000000000001',
    );
    for (const channel of [
      CONVERSATION_THREAD_FORK_CHANNEL,
      CONVERSATION_THREAD_ARCHIVE_CHANNEL,
      CONVERSATION_THREAD_UNARCHIVE_CHANNEL,
      CONVERSATION_THREAD_DELETE_CHANNEL,
    ]) {
      expect(boundary.invoke).toHaveBeenCalledWith(
        channel,
        'thr_0000000000000001',
      );
    }

    const listener = vi.fn();
    const unsubscribe = api.onConversationStateChanged(listener);
    const handleStateChanged = boundary.listeners.get(
      CONVERSATION_STATE_CHANGED_CHANNEL,
    );
    handleStateChanged?.({} as IpcRendererEvent, snapshot);
    handleStateChanged?.({} as IpcRendererEvent, {
      revision: 2,
      phase: 'inProgress',
      turns: [],
    });
    handleStateChanged?.({} as IpcRendererEvent, {
      revision: 3,
      phase: 'ready',
      threadId: 'thr_0000000000000001',
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'failed',
          messages: [],
        },
      ],
    });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(
      boundary.listeners.has(CONVERSATION_STATE_CHANGED_CHANNEL),
    ).toBe(false);

    boundary.invoke.mockResolvedValue({
      accepted: true,
      reason: 'turnActive',
    });
    await expect(
      api.sendConversationMessage('Exact input'),
    ).rejects.toThrow('invalid conversation send result');

    boundary.invoke.mockResolvedValue({
      revision: 4,
      phase: 'ready',
      threadId: 'thr_0000000000000001',
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          messages: [],
          error: { kind: 'transport', retryable: true },
        },
      ],
    });
    await expect(api.getConversationState()).rejects.toThrow(
      'invalid conversation state snapshot',
    );

    boundary.invoke.mockResolvedValue({
      revision: 5,
      phase: 'ready',
      threadId: 'thr_0000000000000001',
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          messages: [
            {
              id: 'item_0000000000000001',
              role: 'agent',
              text: 'Terminal content cannot remain active.',
              status: 'inProgress',
            },
          ],
        },
      ],
    });
    await expect(api.getConversationState()).rejects.toThrow(
      'invalid conversation state snapshot',
    );

    boundary.invoke.mockResolvedValue({
      revision: 6,
      phase: 'ready',
      threadId: 'thr_0000000000000001',
      turns: [
        {
          id: 'turn_0000000000000002',
          status: 'interrupted',
          messages: [],
          workspaceRead: {
            id: 'item_0000000000000002',
            callId: 'call_read',
            path: 'pending.txt',
            callStatus: 'completed',
            result: {
              id: 'item_0000000000000003',
              status: 'inProgress',
              outcome: { type: 'success', bytes: 12 },
            },
          },
        },
      ],
    });
    await expect(api.getConversationState()).rejects.toThrow(
      'invalid conversation state snapshot',
    );

    boundary.invoke.mockResolvedValue({
      revision: 7,
      phase: 'ready',
      threadId: 'thr_0000000000000001',
      navigator: snapshot.navigator,
      turns: [
        {
          id: 'turn_0000000000000003',
          status: 'completed',
          messages: [],
          workspaceList: {
            id: 'item_0000000000000004',
            callId: 'call_list',
            path: '.',
            callStatus: 'completed',
            result: {
              id: 'item_0000000000000005',
              status: 'completed',
              outcome: { type: 'success', entries: 0 },
            },
          },
        },
      ],
    });
    await expect(api.getConversationState()).resolves.toMatchObject({
      turns: [
        {
          workspaceList: {
            result: { outcome: { entries: 0 } },
          },
        },
      ],
    });

    boundary.invoke.mockResolvedValue({
      revision: 8,
      phase: 'unavailable',
      threadId: 'thr_0000000000000001',
      activeTurnId: 'turn_0000000000000002',
      navigator: {
        ...snapshot.navigator,
        status: 'unavailable',
      },
      turns: [
        {
          id: 'turn_0000000000000002',
          status: 'inProgress',
          messages: [
            {
              id: 'item_0000000000000002',
              role: 'agent',
              text: 'Partial response.',
              status: 'inProgress',
            },
          ],
        },
      ],
      notice: {
        kind: 'connectionLost',
        summary: 'The local Agent connection is unavailable.',
      },
    });
    await expect(api.getConversationState()).resolves.toMatchObject({
      phase: 'unavailable',
      activeTurnId: 'turn_0000000000000002',
    });
  });
});
