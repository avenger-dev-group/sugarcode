import { randomUUID } from 'node:crypto';

import {
  isConversationSendRequest,
  isValidThreadSearchInput,
  type ConversationActionResult,
  type ConversationActivity,
  type ConversationAttachment,
  type ConversationStateListener,
  type ConversationStateSnapshot,
  type ConversationThreadNavigatorSnapshot,
  type ConversationTurn,
  type ConversationTurnError,
} from '../../shared/conversation.ts';
import type {
  RuntimeEvent,
  RuntimeContentPart,
  RuntimeModelSelection,
  RuntimeProviderError,
  RuntimeThreadRecord,
  RuntimeThreadSnapshot,
  RuntimeTurnItemRecord,
} from '../../runtime/protocol.ts';
import { createUuidV7 } from './id.ts';
import type { RuntimeSupervisor } from './supervisor.ts';

const accepted = (): ConversationActionResult => ({ accepted: true, reason: 'accepted' });
const rejected = (
  reason: Exclude<ConversationActionResult['reason'], 'accepted'>,
): ConversationActionResult => ({ accepted: false, reason });

const emptyNavigator = (): ConversationThreadNavigatorSnapshot => ({
  status: 'unavailable',
  activeThreadIds: [],
  activeThreadTitles: {},
  activeTruncated: false,
  runningThreadIds: [],
  search: {
    query: '',
    status: 'idle',
    threadIds: [],
    threadTitles: {},
    truncated: false,
  },
});

const titleFromInput = (input: string): string | undefined => {
  const title = input.trim().replace(/\s+/gu, ' ').slice(0, 80);
  return title || undefined;
};

const runtimeError = (error: RuntimeProviderError): ConversationTurnError => ({
  kind:
    error.kind === 'rateLimit'
      ? 'rateLimited'
      : error.kind === 'connection'
        ? 'transport'
        : error.kind === 'cancelled'
          ? 'incomplete'
          : error.kind === 'unknown'
            ? 'server'
            : error.kind,
  retryable: error.retryable,
});

const fallbackModel = (
  wireApi: RuntimeThreadSnapshot['turns'][number]['providerWireApi'],
  model: string,
): RuntimeModelSelection => ({
  profileId: 'recovered',
  providerFamily: wireApi === 'anthropicMessages' ? 'anthropic' : 'openai',
  wireApi,
  modelId: model,
  displayName: model,
  contextWindowTokens: 128_000,
  effectiveCapabilities: {
    toolCalls: true,
    strictTools: false,
    parallelTools: true,
    imageInput: true,
    pdfInput: wireApi === 'anthropicMessages',
  },
});

const modelFromItems = (
  items: readonly RuntimeTurnItemRecord[],
  fallback: RuntimeModelSelection,
): RuntimeModelSelection => {
  const started = items.find((item) => item.kind === 'turn.started')?.payload;
  return started && typeof started.model === 'object' && started.model !== null
    ? (started.model as RuntimeModelSelection)
    : fallback;
};

const attachmentFromPart = (
  part: Extract<RuntimeContentPart, { type: 'asset' }>,
): ConversationAttachment => ({
  assetId: part.asset.assetId,
  sha256: part.asset.sha256,
  mediaType: part.asset.mediaType,
  originalName: part.asset.originalName,
  sizeBytes: part.asset.sizeBytes,
  kind: part.asset.kind,
});

const projectThread = (
  snapshot: RuntimeThreadSnapshot,
): readonly ConversationTurn[] =>
  snapshot.turns.map((record) => {
    const items = snapshot.items.filter((item) => item.turnId === record.id);
    const model = modelFromItems(
      items,
      fallbackModel(record.providerWireApi, record.model),
    );
    const user = items.find((item) => item.kind === 'turn.userMessage')?.payload;
    const userContent = Array.isArray(user?.content) ? user.content : [];
    const userText = userContent
          .filter(
            (part): part is { type: 'text'; text: string } =>
              typeof part === 'object' &&
              part !== null &&
              (part as { type?: unknown }).type === 'text' &&
              typeof (part as { text?: unknown }).text === 'string',
          )
          .map((part) => part.text)
          .join('\n');
    const attachments = userContent.flatMap((part): readonly ConversationAttachment[] =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'asset' &&
      typeof (part as { asset?: unknown }).asset === 'object' &&
      (part as { asset?: unknown }).asset !== null
        ? [attachmentFromPart(part as Extract<RuntimeContentPart, { type: 'asset' }>)]
        : [],
    );
    const finalText = items
      .filter(
        (item) =>
          item.kind === 'turn.textDelta' && item.payload.phase === 'final',
      )
      .map((item) => String(item.payload.delta ?? ''))
      .join('');
    const commentary = items
      .filter(
        (item) =>
          item.kind === 'turn.textDelta' && item.payload.phase === 'commentary',
      )
      .map(
        (item): ConversationActivity => ({
          type: 'commentary',
          activity: {
            id: item.id,
            text: String(item.payload.delta ?? ''),
            status: 'completed',
          },
        }),
      );
    const messages = [
      ...(userText || attachments.length > 0
        ? [{
            id: `${record.id}:user`,
            role: 'user' as const,
            text: userText,
            ...(attachments.length > 0 ? { attachments } : {}),
            status: 'completed' as const,
          }]
        : []),
      ...(finalText
        ? [{ id: `${record.id}:agent`, role: 'agent' as const, text: finalText, status: 'completed' as const }]
        : []),
    ];
    const error = record.errorJson
      ? (() => {
          try {
            return runtimeError(JSON.parse(record.errorJson) as RuntimeProviderError);
          } catch {
            return { kind: 'stateUnavailable' as const, retryable: true };
          }
        })()
      : undefined;
    return {
      id: record.id,
      status: record.status === 'running' ? 'interrupted' : record.status,
      model,
      messages,
      ...(commentary.length > 0 ? { activities: commentary } : {}),
      ...(error ? { error } : {}),
    };
  });

export class RuntimeConversationController {
  private readonly runtime: RuntimeSupervisor;
  private readonly listeners = new Set<ConversationStateListener>();
  private readonly threadRecords = new Map<string, RuntimeThreadRecord>();
  private readonly turnsByThread = new Map<string, ConversationTurn[]>();
  private workspaceId: string | null = null;
  private revision = 0;
  private phase: ConversationStateSnapshot['phase'] = 'unavailable';
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private navigator = emptyNavigator();
  private notice: ConversationStateSnapshot['notice'];

  constructor(runtime: RuntimeSupervisor) {
    this.runtime = runtime;
    runtime.subscribe(this.handleRuntimeEvent);
  }

  getSnapshot = (): ConversationStateSnapshot => ({
    revision: this.revision,
    phase: this.phase,
    ...(this.threadId ? { threadId: this.threadId } : {}),
    ...(this.activeTurnId ? { activeTurnId: this.activeTurnId } : {}),
    turns: this.threadId ? this.turnsByThread.get(this.threadId) ?? [] : [],
    navigator: this.navigator,
    ...(this.notice ? { notice: this.notice } : {}),
  });

  subscribe = (listener: ConversationStateListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  switchWorkspace = async (workspaceId: string): Promise<boolean> => {
    this.workspaceId = workspaceId;
    this.threadId = null;
    this.activeTurnId = null;
    this.phase = 'unavailable';
    this.threadRecords.clear();
    this.turnsByThread.clear();
    this.navigator = { ...emptyNavigator(), status: 'loading' };
    this.publish();
    try {
      const event = await this.runtime.request(
        { type: 'thread.list', requestId: randomUUID(), workspaceId },
        'thread.listResult',
      );
      if (this.workspaceId !== workspaceId) {
        return true;
      }
      this.applyThreadList(event.threads);
      this.phase = 'idle';
      this.publish();
      return true;
    } catch {
      if (this.workspaceId === workspaceId) {
        this.navigator = { ...this.navigator, status: 'error' };
        this.notice = { kind: 'requestFailed', summary: 'Threads could not be loaded from local storage.' };
        this.publish();
      }
      return false;
    }
  };

  startTurn = async (input: unknown): Promise<ConversationActionResult> => {
    if (!isConversationSendRequest(input)) {
      return rejected('invalidInput');
    }
    if (!this.workspaceId || this.phase === 'unavailable') {
      return rejected('unavailable');
    }
    if (this.activeTurnId || this.navigator.pendingMutation) {
      return rejected('turnActive');
    }
    this.phase = 'starting';
    this.notice = undefined;
    this.publish();
    try {
      const content: RuntimeContentPart[] = input.input.length > 0
        ? [{ type: 'text', text: input.input }]
        : [];
      const attachments: ConversationAttachment[] = [];
      for (const attachment of input.attachments ?? []) {
        const imported = await this.runtime.request(
          {
            type: 'asset.import',
            requestId: randomUUID(),
            fileName: attachment.fileName,
            ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
            data: attachment.data,
          },
          'asset.imported',
        );
        content.push({ type: 'asset', asset: imported.asset });
        attachments.push({
          ...attachmentFromPart({ type: 'asset', asset: imported.asset }),
          ...(imported.asset.kind === 'image'
            ? { previewUrl: `data:${imported.asset.mediaType};base64,${attachment.data}` }
            : {}),
        });
      }
      if (!this.threadId) {
        const created = await this.runtime.request(
          {
            type: 'thread.create',
            requestId: randomUUID(),
            workspaceId: this.workspaceId,
            ...(titleFromInput(input.input) ? { title: titleFromInput(input.input) } : {}),
          },
          'thread.mutated',
        );
        if (!created.snapshot) {
          throw new Error('The local runtime did not return the new Thread.');
        }
        this.threadId = created.threadId;
        this.threadRecords.set(created.threadId, created.snapshot.thread);
        this.turnsByThread.set(created.threadId, []);
        this.refreshNavigator();
      }
      const turnId = createUuidV7();
      const userMessage = {
        id: `${turnId}:user`,
        role: 'user' as const,
        text: input.input,
        ...(attachments.length > 0 ? { attachments } : {}),
        status: 'inProgress' as const,
      };
      this.turnsByThread.set(this.threadId, [
        ...(this.turnsByThread.get(this.threadId) ?? []),
        { id: turnId, status: 'inProgress', messages: [userMessage] },
      ]);
      this.activeTurnId = turnId;
      this.runtime.send({
        type: 'turn.start',
        requestId: randomUUID(),
        workspaceId: this.workspaceId,
        threadId: this.threadId,
        turnId,
        ...(input.modelProfileId ? { modelProfileId: input.modelProfileId } : {}),
        content,
      });
      this.publish();
      return accepted();
    } catch {
      this.phase = this.threadId ? 'ready' : 'idle';
      this.activeTurnId = null;
      this.notice = { kind: 'requestFailed', summary: 'The local Agent could not start this Turn.' };
      this.publish();
      return rejected('unavailable');
    }
  };

  stopTurn = async (threadId: unknown): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string' || threadId !== this.threadId) {
      return rejected('unknownThread');
    }
    if (!this.workspaceId || !this.activeTurnId) {
      return rejected('noActiveTurn');
    }
    this.phase = 'stopping';
    this.runtime.send({
      type: 'turn.cancel',
      requestId: randomUUID(),
      workspaceId: this.workspaceId,
      threadId,
      turnId: this.activeTurnId,
    });
    this.publish();
    return accepted();
  };

  searchThreads = async (query: unknown): Promise<ConversationActionResult> => {
    if (!isValidThreadSearchInput(query)) {
      return rejected('invalidSearch');
    }
    if (!this.workspaceId) {
      return rejected('unavailable');
    }
    this.navigator = {
      ...this.navigator,
      search: { ...this.navigator.search, query: query.trim(), status: 'loading' },
    };
    this.publish();
    try {
      const event = await this.runtime.request(
        { type: 'thread.list', requestId: randomUUID(), workspaceId: this.workspaceId, query: query.trim() },
        'thread.listResult',
      );
      const titles = Object.fromEntries(
        event.threads.flatMap((thread) => thread.title ? [[thread.id, thread.title]] : []),
      );
      this.navigator = {
        ...this.navigator,
        search: {
          query: query.trim(),
          status: event.threads.length > 0 ? 'ready' : 'empty',
          threadIds: event.threads.map((thread) => thread.id),
          threadTitles: titles,
          truncated: event.threads.length === 200,
        },
      };
      this.publish();
      return accepted();
    } catch {
      this.navigator = { ...this.navigator, search: { ...this.navigator.search, status: 'error' } };
      this.publish();
      return rejected('unavailable');
    }
  };

  selectThread = async (threadId: unknown): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string' || !this.threadRecords.has(threadId)) {
      return rejected('unknownThread');
    }
    if (!this.workspaceId || this.activeTurnId) {
      return rejected(this.activeTurnId ? 'turnActive' : 'unavailable');
    }
    this.navigator = { ...this.navigator, pendingThreadId: threadId };
    this.publish();
    try {
      const event = await this.runtime.request(
        { type: 'thread.load', requestId: randomUUID(), workspaceId: this.workspaceId, threadId },
        'thread.loaded',
      );
      if (event.snapshot.thread.workspaceId !== this.workspaceId) {
        throw new Error('Thread crossed workspace ownership.');
      }
      this.threadId = threadId;
      this.turnsByThread.set(threadId, [...projectThread(event.snapshot)]);
      this.phase = 'ready';
      this.navigator = { ...this.navigator, pendingThreadId: undefined, selectionNotice: undefined };
      this.publish();
      return accepted();
    } catch {
      this.navigator = { ...this.navigator, pendingThreadId: undefined, selectionNotice: 'That Thread could not be restored safely.' };
      this.publish();
      return rejected('unavailable');
    }
  };

  startNewThread = (): ConversationActionResult => {
    if (!this.workspaceId || this.activeTurnId) {
      return rejected(this.activeTurnId ? 'turnActive' : 'unavailable');
    }
    this.threadId = null;
    this.phase = 'idle';
    this.navigator = { ...this.navigator, archivedUndoThreadId: undefined };
    this.publish();
    return accepted();
  };

  forkThread = async (threadId: unknown): Promise<ConversationActionResult> =>
    this.mutateThread('fork', threadId);

  archiveThread = async (threadId: unknown): Promise<ConversationActionResult> =>
    this.mutateThread('archive', threadId);

  unarchiveThread = async (threadId: unknown): Promise<ConversationActionResult> => {
    if (threadId !== this.navigator.archivedUndoThreadId) {
      return rejected('unknownThread');
    }
    return this.mutateThread('unarchive', threadId);
  };

  deleteThread = async (threadId: unknown): Promise<ConversationActionResult> =>
    this.mutateThread('delete', threadId);

  private mutateThread = async (
    operation: 'fork' | 'archive' | 'unarchive' | 'delete',
    threadId: unknown,
  ): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string' || (!this.threadRecords.has(threadId) && operation !== 'unarchive')) {
      return rejected('unknownThread');
    }
    if (!this.workspaceId || this.activeTurnId || this.navigator.pendingMutation) {
      return rejected(this.activeTurnId ? 'turnActive' : 'unavailable');
    }
    this.navigator = { ...this.navigator, pendingMutation: { kind: operation, threadId } };
    this.publish();
    try {
      const event = await this.runtime.request(
        { type: `thread.${operation}`, requestId: randomUUID(), workspaceId: this.workspaceId, threadId } as const,
        'thread.mutated',
      );
      if (operation === 'fork' && event.snapshot) {
        this.threadRecords.set(event.threadId, event.snapshot.thread);
        this.turnsByThread.set(event.threadId, [...projectThread(event.snapshot)]);
        this.threadId = event.threadId;
        this.phase = 'ready';
      } else if (operation === 'unarchive' && event.snapshot) {
        this.threadRecords.set(threadId, event.snapshot.thread);
        this.turnsByThread.set(threadId, [...projectThread(event.snapshot)]);
        this.threadId = threadId;
        this.phase = 'ready';
      } else if (operation === 'archive' || operation === 'delete') {
        this.threadRecords.delete(threadId);
        this.turnsByThread.delete(threadId);
        if (this.threadId === threadId) {
          this.threadId = null;
          this.phase = 'idle';
        }
      }
      this.navigator = {
        ...this.navigator,
        pendingMutation: undefined,
        archivedUndoThreadId: operation === 'archive' ? threadId : undefined,
      };
      this.refreshNavigator();
      this.publish();
      return accepted();
    } catch {
      this.navigator = { ...this.navigator, pendingMutation: undefined, mutationNotice: 'The Thread lifecycle change was rejected.' };
      this.publish();
      return rejected('unavailable');
    }
  };

  private handleRuntimeEvent = (event: RuntimeEvent): void => {
    if (!('workspaceId' in event) || event.workspaceId !== this.workspaceId) {
      return;
    }
    if (
      (!event.type.startsWith('turn.') && !event.type.startsWith('approval.')) ||
      !('threadId' in event) ||
      !('turnId' in event)
    ) {
      return;
    }
    const turns = [...(this.turnsByThread.get(event.threadId) ?? [])];
    const index = turns.findIndex((turn) => turn.id === event.turnId);
    if (index < 0) {
      return;
    }
    const turn = turns[index];
    switch (event.type) {
      case 'turn.started':
        turns[index] = { ...turn, model: event.model };
        this.phase = 'inProgress';
        break;
      case 'turn.userMessage':
        turns[index] = {
          ...turn,
          messages: turn.messages.map((message) => message.role === 'user' ? { ...message, status: 'completed' } : message),
        };
        break;
      case 'turn.textDelta': {
        if (event.phase === 'commentary') {
          const activities = [...(turn.activities ?? [])];
          const activityIndex = activities.findIndex(
            (activity) => activity.type === 'commentary' && activity.activity.id === event.itemId,
          );
          if (activityIndex >= 0 && activities[activityIndex]?.type === 'commentary') {
            const current = activities[activityIndex];
            activities[activityIndex] = { type: 'commentary', activity: { ...current.activity, text: current.activity.text + event.delta } };
          } else {
            activities.push({ type: 'commentary', activity: { id: event.itemId, text: event.delta, status: 'inProgress' } });
          }
          turns[index] = { ...turn, activities };
        } else {
          const messages = [...turn.messages];
          const agentIndex = messages.findIndex((message) => message.role === 'agent');
          if (agentIndex >= 0) {
            const current = messages[agentIndex];
            messages[agentIndex] = { ...current, text: current.text + event.delta };
          } else {
            messages.push({ id: `${event.turnId}:agent`, role: 'agent', text: event.delta, status: 'inProgress' });
          }
          turns[index] = { ...turn, messages };
        }
        break;
      }
      case 'turn.usage':
        turns[index] = {
          ...turn,
          usage: {
            lastRequest: event.usage,
            turnTotal: event.usage,
            requestCount: 1,
            contextWindowTokens: turn.model?.contextWindowTokens ?? 128_000,
            source: 'provider',
          },
        };
        break;
      case 'approval.requested': {
        const activities = [...(turn.activities ?? [])];
        activities.push({
          type: 'commandApproval',
          activity: {
            callItemId: event.operationId,
            id: `${event.approvalId}:request`,
            callId: event.operationId,
            approvalId: event.approvalId,
            command: event.argumentsSummary,
            argumentCount: 0,
            fullAccess: event.fullAccess,
            requestStatus: 'inProgress',
          },
        });
        turns[index] = { ...turn, activities };
        break;
      }
      case 'approval.resolved': {
        const activities = turn.activities?.map((activity) =>
          activity.type === 'commandApproval' &&
          activity.activity.approvalId === event.approvalId
            ? {
                type: 'commandApproval' as const,
                activity: {
                  ...activity.activity,
                  requestStatus: 'completed' as const,
                  decision: {
                    id: `${event.approvalId}:decision`,
                    status: 'completed' as const,
                    value: event.decision,
                  },
                },
              }
            : activity,
        );
        turns[index] = { ...turn, ...(activities ? { activities } : {}) };
        break;
      }
      case 'turn.completed': {
        const messages = turn.messages.map((message) => ({ ...message, status: 'completed' as const }));
        const activities = turn.activities?.map((activity) =>
          activity.type === 'commentary'
            ? { type: 'commentary' as const, activity: { ...activity.activity, status: 'completed' as const } }
            : activity,
        );
        turns[index] = {
          ...turn,
          status: event.status,
          messages,
          ...(activities ? { activities } : {}),
          ...(event.error ? { error: runtimeError(event.error) } : {}),
        };
        if (this.activeTurnId === event.turnId) {
          this.activeTurnId = null;
          this.phase = 'ready';
        }
        break;
      }
      default:
        return;
    }
    this.turnsByThread.set(event.threadId, turns);
    this.publish();
  };

  private applyThreadList = (threads: readonly RuntimeThreadRecord[]): void => {
    this.threadRecords.clear();
    for (const thread of threads) {
      this.threadRecords.set(thread.id, thread);
    }
    this.refreshNavigator();
  };

  private refreshNavigator = (): void => {
    const threads = [...this.threadRecords.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id),
    );
    this.navigator = {
      ...this.navigator,
      status: 'ready',
      activeThreadIds: threads.map((thread) => thread.id),
      activeThreadTitles: Object.fromEntries(
        threads.flatMap((thread) => thread.title ? [[thread.id, thread.title]] : []),
      ),
      activeTruncated: threads.length === 200,
      runningThreadIds: this.activeTurnId && this.threadId ? [this.threadId] : [],
    };
  };

  private publish = (): void => {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  };
}
