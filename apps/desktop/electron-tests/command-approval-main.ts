import {
  app,
  BrowserWindow,
  ipcMain,
  type NativeImage,
} from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CommandApprovalController } from '@/main/app-server/command-approval/controller';
import { registerCommandApprovalIpc } from '@/main/app-server/command-approval/ipc';
import { ConversationController } from '@/main/app-server/conversation/controller';
import { registerConversationIpc } from '@/main/app-server/conversation/ipc';
import type { ConversationRpc } from '@/main/app-server/conversation/rpc-client';
import { McpApprovalController } from '@/main/app-server/mcp/approval-controller';
import { registerMcpIpc } from '@/main/app-server/mcp/ipc';
import { McpSessionController } from '@/main/app-server/mcp/session-controller';
import type { ModelConfigController } from '@/main/app-server/model-config/controller';
import { registerModelConfigIpc } from '@/main/app-server/model-config/ipc';
import {
  CONNECTION_STATE_GET_CHANNEL,
} from '@/shared/connection';

type WrittenDecision = Readonly<{
  id: string | number;
  decision: 'approved' | 'denied';
}>;

const resultPrefix = 'SUGARCODE_ELECTRON_RESULT:';
const writtenDecisions: WrittenDecision[] = [];
const mcpWrittenDecisions: WrittenDecision[] = [];
const mcpRestarts: string[][] = [];
const lifecycleFailures: string[] = [];
const conversationInputs: string[] = [];
const interruptRequests: string[] = [];
let modelCredentialObserved = false;
const fileChangeBeforeSha256 = 'a'.repeat(64);
const fileChangeAfterSha256 = 'b'.repeat(64);
const fileChangeDiff =
  '--- a/recovered/notes.txt\n' +
  '+++ b/recovered/notes.txt\n' +
  '@@ -1,1 +1,1 @@\n' +
  '-old\n' +
  '+new\n';
let window: BrowserWindow | null = null;

const request = (approvalId: string) => ({
  kind: 'request' as const,
  id: approvalId,
  method: 'item/commandExecution/requestApproval',
  params: {
    approvalId,
    threadId: 'thr_0000000000000001',
    turnId: 'turn_0000000000000001',
    callId: `call_${approvalId}`,
    command: '/usr/bin/printf',
    arguments: ['%s; not shell', 'hello world', '雪'],
    cwd: '.',
    approvalScope: 'command',
    environmentPolicy: 'minimalV1',
    sandboxed: true,
    sandboxPolicy: 'filesystemReadOnlyV1',
    networkPolicy: 'networkDeniedV1',
  },
});

const completion = (approvalId: string, decision: string) => ({
  kind: 'notification' as const,
  method: 'item/completed',
  params: {
    threadId: 'thr_0000000000000001',
    turnId: 'turn_0000000000000001',
    item: {
      type: 'commandApprovalDecision',
      id: `item_${approvalId}`,
      approvalId,
      decision,
    },
  },
});

const mcpRequest = (approvalId: string) => ({
  kind: 'request' as const,
  id: approvalId,
  method: 'item/mcpToolCall/requestApproval',
  params: {
    approvalId,
    threadId: 'thr_0000000000000001',
    turnId: 'turn_0000000000000001',
    callId: `call_${approvalId}`,
    name: 'mcp__alpha__lookup',
    arguments: {
      nested: { exact: '雪' },
      query: 'sugar',
    },
    argumentsBytes: 42,
    argumentsSha256: 'c'.repeat(64),
    inventorySha256: 'd'.repeat(64),
  },
});

const mcpCompletion = (approvalId: string, decision: string) => ({
  kind: 'notification' as const,
  method: 'item/completed',
  params: {
    threadId: 'thr_0000000000000001',
    turnId: 'turn_0000000000000001',
    item: {
      type: 'mcpToolCallApprovalDecision',
      id: `item_${approvalId}`,
      approvalId,
      decision,
    },
  },
});

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const evaluate = async <Value>(source: string): Promise<Value> => {
  if (!window || window.isDestroyed()) {
    throw new Error('Electron test window is unavailable.');
  }
  return window.webContents.executeJavaScript(source, true) as Promise<Value>;
};

const waitForAnimationFrame = async (): Promise<void> => {
  await evaluate<void>(
    'new Promise((resolve) => requestAnimationFrame(() => resolve()))',
  );
};

const capturePageWithRetry = async (
  label: string,
): Promise<NativeImage> => {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await waitForAnimationFrame();
    let screenshot: NativeImage;
    try {
      if (!window || window.isDestroyed()) {
        throw new Error('Electron test window is unavailable.');
      }
      screenshot = await window.webContents.capturePage();
    } catch (error) {
      const isTransientVizFailure =
        error instanceof Error && error.message === 'UnknownVizError';
      if (!isTransientVizFailure) {
        throw error;
      }
      if (attempt === maxAttempts) {
        throw new Error(
          `Electron ${label} capture failed with UnknownVizError after ${maxAttempts} attempts.`,
        );
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      continue;
    }
    if (screenshot.isEmpty()) {
      throw new Error(`Electron ${label} did not paint.`);
    }
    return screenshot;
  }
  throw new Error(`Electron ${label} capture exhausted unexpectedly.`);
};

const run = async (): Promise<void> => {
  const controller = new CommandApprovalController({
    platform: 'darwin',
    createPresentationId: () => `presentation/${writtenDecisions.length + 1}`,
    writeDecision: async (id, decision) => {
      writtenDecisions.push({ id, decision });
    },
    onProtocolFailure: () => lifecycleFailures.push('protocol'),
    onWriteFailure: () => lifecycleFailures.push('write'),
    onSurfaceFailure: () => lifecycleFailures.push('surface'),
  });
  const mcpSession = new McpSessionController({
    getRestartBlock: () => null,
    restart: async (serverIds) => {
      mcpRestarts.push([...serverIds]);
      return true;
    },
  });
  mcpSession.initialize([
    { id: 'alpha', transport: 'stdio' },
    { id: 'beta', transport: 'stdio' },
  ]);
  const mcpApprovals = new McpApprovalController({
    getActiveServerIds: () => mcpSession.getActiveServerIds(),
    createPresentationId: () =>
      `mcp-presentation/${mcpWrittenDecisions.length + 1}`,
    writeDecision: async (id, decision) => {
      mcpWrittenDecisions.push({ id, decision });
    },
    onProtocolFailure: () => lifecycleFailures.push('mcp-protocol'),
    onWriteFailure: () => lifecycleFailures.push('mcp-write'),
    onSurfaceFailure: () => lifecycleFailures.push('mcp-surface'),
  });
  let turnSequence = 0;
  let resolveInterrupt: (() => void) | null = null;
  const conversationRpc: ConversationRpc = {
    findLatestActiveThread: async () => 'thr_0000000000000100',
    listActiveThreads: async () => ({
      data: [
        { id: 'thr_0000000000000100' },
        { id: 'thr_0000000000000090' },
      ],
      nextCursor: null,
    }),
    searchThreads: async () => ({
      data: [{ id: 'thr_0000000000000090' }],
      nextCursor: null,
    }),
    resumeThread: async (threadId) => {
      if (threadId === 'thr_0000000000000090') {
        return {
          threadId,
          turns: [
            {
              id: 'turn_0000000000000090',
              status: 'completed',
              items: [
                {
                  type: 'agentMessage',
                  id: 'item_0000000000000090',
                  text: 'Historical Electron answer.',
                },
              ],
            },
          ],
        };
      }
      return {
      threadId: 'thr_0000000000000100',
      turns: [
        {
          id: 'turn_0000000000000099',
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              id: 'item_0000000000000098',
              text: 'Recovered Electron input.',
            },
            {
              type: 'workspaceReadCall',
              id: 'item_0000000000000098-read',
              callId: 'call_recovered_read',
              path: 'recovered/context.txt',
            },
            {
              type: 'workspaceReadResult',
              id: 'item_0000000000000098-read-result',
              callId: 'call_recovered_read',
              outcome: { type: 'success', bytes: 25 },
            },
            {
              type: 'agentMessage',
              id: 'item_0000000000000099',
              text: [
                '## Recovered Electron answer',
                '',
                '- Durable restart item',
                '',
                '```Rust title="restart-proof"',
                'fn recovered() {',
                '  println!("restart-proof");',
                '}',
                '```',
              ].join('\n'),
            },
          ],
        },
        {
          id: 'turn_0000000000000100',
          status: 'failed',
          items: [
            {
              type: 'userMessage',
              id: 'item_0000000000000100',
              text: 'Recovered rate-limited input.',
            },
            {
              type: 'agentMessage',
              id: 'item_0000000000000101',
              text: [
                '```TypeScript',
                'throw new Error("rate limited");',
                '```',
              ].join('\n'),
            },
          ],
          error: { kind: 'rateLimited', retryable: true },
        },
        {
          id: 'turn_0000000000000098',
          status: 'completed',
          items: [
            {
              type: 'workspaceListCall',
              id: 'item_0000000000000097-list',
              callId: 'call_recovered_list',
              path: 'recovered/directory',
            },
            {
              type: 'workspaceListResult',
              id: 'item_0000000000000097-list-result',
              callId: 'call_recovered_list',
              outcome: { type: 'success', entries: 0 },
            },
          ],
        },
        {
          id: 'turn_0000000000000097',
          status: 'completed',
          items: [
            {
              type: 'workspaceListCall',
              id: 'item_0000000000000096-list',
              callId: 'call_recovered_list_failure',
              path: 'recovered/missing-directory',
            },
            {
              type: 'workspaceListResult',
              id: 'item_0000000000000096-list-result',
              callId: 'call_recovered_list_failure',
              outcome: { type: 'error', kind: 'notFound' },
            },
          ],
        },
        {
          id: 'turn_0000000000000096',
          status: 'completed',
          items: [
            {
              type: 'workspaceSearchCall',
              id: 'item_0000000000000095-search',
              callId: 'call_recovered_search',
              path: 'recovered/search-root',
              query: 'durable needle',
            },
            {
              type: 'workspaceSearchResult',
              id: 'item_0000000000000095-search-result',
              callId: 'call_recovered_search',
              outcome: { type: 'success', matches: 200, truncated: true },
            },
          ],
        },
        {
          id: 'turn_0000000000000095',
          status: 'completed',
          items: [
            {
              type: 'workspaceSearchCall',
              id: 'item_0000000000000094-search',
              callId: 'call_recovered_search_failure',
              path: 'recovered/unreadable-root',
              query: 'permission needle',
            },
            {
              type: 'workspaceSearchResult',
              id: 'item_0000000000000094-search-result',
              callId: 'call_recovered_search_failure',
              outcome: { type: 'error', kind: 'accessDenied' },
            },
          ],
        },
        {
          id: 'turn_0000000000000093',
          status: 'completed',
          items: [
            {
              type: 'workspacePatchCall',
              id: 'item_0000000000000093-patch',
              callId: 'call_recovered_patch',
              path: 'recovered/notes.txt',
            },
            {
              type: 'workspacePatchChange',
              id: 'item_0000000000000093-change',
              callId: 'call_recovered_patch',
              path: 'recovered/notes.txt',
              kind: 'update',
              diff: fileChangeDiff,
              beforeSha256: fileChangeBeforeSha256,
              afterSha256: fileChangeAfterSha256,
              beforeBytes: 4,
              afterBytes: 4,
              newlineStyle: 'lf',
              finalNewline: true,
              status: 'inProgress',
            },
            {
              type: 'workspacePatchResult',
              id: 'item_0000000000000093-result',
              callId: 'call_recovered_patch',
              outcome: {
                type: 'success',
                path: 'recovered/notes.txt',
                beforeSha256: fileChangeBeforeSha256,
                afterSha256: fileChangeAfterSha256,
                beforeBytes: 4,
                afterBytes: 4,
              },
            },
          ],
        },
        {
          id: 'turn_0000000000000092',
          status: 'interrupted',
          items: [
            {
              type: 'workspacePatchCall',
              id: 'item_0000000000000092-patch',
              callId: 'call_interrupted_patch',
              path: 'recovered/pending.txt',
            },
            {
              type: 'workspacePatchChange',
              id: 'item_0000000000000092-change',
              callId: 'call_interrupted_patch',
              path: 'recovered/pending.txt',
              kind: 'update',
              diff: fileChangeDiff.replaceAll(
                'recovered/notes.txt',
                'recovered/pending.txt',
              ),
              beforeSha256: fileChangeBeforeSha256,
              afterSha256: fileChangeAfterSha256,
              beforeBytes: 4,
              afterBytes: 4,
              newlineStyle: 'lf',
              finalNewline: true,
              status: 'inProgress',
            },
          ],
        },
        {
          id: 'turn_0000000000000094',
          status: 'failed',
          items: [
            {
              type: 'commandCall',
              id: 'item_recovered_command',
              callId: 'call_recovered_command',
              command: '/usr/bin/printf',
              arguments: ['private-electron-argument'],
            },
            {
              type: 'commandApprovalRequest',
              id: 'item_recovered_command_request',
              approvalId: 'approval_recovered_command',
              callId: 'call_recovered_command',
              command: '/usr/bin/printf',
              arguments: ['private-electron-argument'],
            },
            {
              type: 'commandApprovalDecision',
              id: 'item_recovered_command_decision',
              approvalId: 'approval_recovered_command',
              decision: 'approved',
            },
            {
              type: 'commandExecutionAttempt',
              id: 'item_recovered_command_attempt',
              approvalId: 'approval_recovered_command',
              callId: 'call_recovered_command',
            },
            {
              type: 'commandExecutionResult',
              id: 'item_recovered_command_result',
              callId: 'call_recovered_command',
              outcome: {
                type: 'process',
                stdoutBytes: 24,
                stderrBytes: 9,
                stdoutTruncated: false,
                stderrTruncated: true,
                encoding: 'utf8Lossy',
                durationMs: 12,
                outcome: { type: 'exitCode', code: 7 },
                sandboxPolicy: 'filesystemReadOnlyV1',
                networkPolicy: 'networkDeniedV1',
              },
            },
          ],
          error: { kind: 'server', retryable: false },
        },
      ],
      };
    },
    startThread: async () => ({
      thread: { id: 'thr_0000000000000100' },
    }),
    startTurn: async (_threadId, input) => {
      turnSequence += 1;
      conversationInputs.push(input);
      return {
        turn: {
          id: `turn_000000000000010${turnSequence}`,
          status: 'inProgress',
        },
      };
    },
    interruptTurn: async (_threadId, turnId) => {
      interruptRequests.push(turnId);
      await new Promise<void>((resolve) => {
        resolveInterrupt = resolve;
      });
      return {};
    },
  };
  const conversation = new ConversationController({
    getRpc: () => conversationRpc,
    onProtocolFailure: () => lifecycleFailures.push('conversation-protocol'),
  });
  if (!(await conversation.restoreLatestActiveThread())) {
    throw new Error('Electron conversation recovery failed.');
  }
  conversation.connectionReady();
  const rendererPath = path.join(
    __dirname,
    'renderer',
    'index.html',
  );
  const rendererUrl = pathToFileURL(rendererPath).toString();
  window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on(
    'did-start-navigation',
    (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) {
        controller.surfaceUnavailable();
        mcpApprovals.surfaceUnavailable();
      }
    },
  );
  window.webContents.on('render-process-gone', () => {
    controller.surfaceUnavailable();
    mcpApprovals.surfaceUnavailable();
  });
  window.once('closed', () => {
    controller.surfaceUnavailable();
    mcpApprovals.surfaceUnavailable();
    window = null;
  });
  ipcMain.handle(CONNECTION_STATE_GET_CHANNEL, () => ({
    revision: 1,
    status: 'ready',
  }));
  const disposeApprovalIpc = registerCommandApprovalIpc({
    controller,
    getMainWindow: () => window,
    isAllowedUrl: (url) => url === rendererUrl,
  });
  const disposeConversationIpc = registerConversationIpc({
    controller: conversation,
    getMainWindow: () => window,
    isAllowedUrl: (url) => url === rendererUrl,
  });
  const disposeMcpIpc = registerMcpIpc({
    session: mcpSession,
    approvals: mcpApprovals,
    getMainWindow: () => window,
    isAllowedUrl: (url) => url === rendererUrl,
  });
  const modelInspection = {
    contractVersion: 1 as const,
    revision: 'e'.repeat(64),
    config: {
      apiFormat: 'openai-chat-completions' as const,
      endpoint: 'http://127.0.0.1:18080/v1/chat/completions',
      model: 'electron-fixture-model',
      credentialReference: 'model-api-token',
    },
    credentialStatus: 'present' as const,
  };
  const modelConfigController = {
    inspect: async () => modelInspection,
    save: async (request: unknown) => {
      const candidate = request as {
        credential?: string;
      };
      modelCredentialObserved =
        candidate.credential === 'electron-secret-sentinel';
      return {
        accepted: true,
        state: 'active',
        inspection: modelInspection,
      };
    },
    deleteCredential: async () => ({
      accepted: true,
      state: 'active',
      inspection: {
        ...modelInspection,
        credentialStatus: 'missing',
      },
    }),
    retryConnection: async () => ({
      accepted: true,
      state: 'active',
      inspection: modelInspection,
    }),
  } as unknown as ModelConfigController;
  const disposeModelConfigIpc = registerModelConfigIpc({
    controller: modelConfigController,
    getMainWindow: () => window,
    isAllowedUrl: (url) => url === rendererUrl,
  });
  const waitForDurableItemIdentity = async (
    itemId: string,
    label: string,
  ): Promise<void> => {
    const selector = `[aria-label="Durable Item ${itemId}"]`;
    await waitFor(
      () =>
        evaluate<boolean>(
          `document.querySelector(${JSON.stringify(selector)})?.textContent === ${JSON.stringify(`Item ${itemId}`)}`,
        ),
      label,
    );
  };

  await window.loadFile(rendererPath);
  window.show();
  await evaluate(`document.querySelector(
    'button[aria-label="Open model settings"]',
  )?.click()`);
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector('[role="dialog"] #model-endpoint')?.value ===
          'http://127.0.0.1:18080/v1/chat/completions'`,
      ),
    'model configuration dialog',
  );
  await evaluate(`(() => {
    const password = document.querySelector('#model-credential');
    if (!(password instanceof HTMLInputElement) ||
        password.type !== 'password' ||
        password.autocomplete !== 'new-password') {
      throw new Error('Secure model credential field is unavailable.');
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(password, 'electron-secret-sentinel');
    document.querySelector(
      '[role="dialog"] button[type="submit"]',
    )?.click();
    if (password.value !== '') {
      throw new Error('Credential field was not cleared on submit.');
    }
  })()`);
  await waitFor(
    () =>
      modelCredentialObserved &&
      evaluate<boolean>(
        `document.body.textContent?.includes(
          'Saved and active.',
        ) === true && !document.body.textContent?.includes(
          'electron-secret-sentinel',
        )`,
      ),
    'model configuration save and redaction',
  );
  await evaluate(`document.querySelector(
    'button[aria-label="Close model settings"]',
  )?.click()`);
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector('[role="dialog"]') === null`,
      ),
    'model configuration dialog dismissal',
  );
  await evaluate('window.sugarcode.getCommandApprovalState()');
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Agent response"] h2',
        )?.textContent === 'Recovered Electron answer'`,
      ),
    'recovered Electron conversation',
  );
  await evaluate(`(() => {
    const input = document.querySelector('#thread-search');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Thread search input not found.');
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, 'historical electron');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector(
      'button[aria-label="Search Threads"]',
    )?.click();
  })()`);
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.body.textContent?.includes('1 matching Threads') === true`,
      ),
    'bounded Thread search result',
  );
  await evaluate(`document.querySelector(
    'button[aria-label="Thread thr_0000000000000090"]',
  )?.click()`);
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Agent response"]',
        )?.textContent?.includes('Historical Electron answer.') === true &&
        document.querySelector(
          '[aria-label="Current durable Thread thr_0000000000000090"]',
        ) !== null`,
      ),
    'historical Thread transcript replacement',
  );
  await evaluate(`document.querySelector(
    'button[aria-label="Clear Thread search"]',
  )?.click()`);
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          'button[aria-label="Thread thr_0000000000000100"]',
        ) !== null`,
      ),
    'active Thread list after clearing search',
  );
  await evaluate(`document.querySelector(
    'button[aria-label="Thread thr_0000000000000100"]',
  )?.click()`);
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Agent response"] h2',
        )?.textContent === 'Recovered Electron answer'`,
      ),
    'return to latest Thread',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `Array.from(document.querySelectorAll('figure')).some((figure) =>
          figure.textContent?.includes('Language hintRust') === true &&
          figure.textContent?.includes('3 lines') === true &&
          figure.querySelector('pre code')?.textContent ===
            'fn recovered() {\\n  println!("restart-proof");\\n}'
        )`,
      ),
    'recovered fenced-code line count',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Current durable Thread thr_0000000000000100"]',
        )?.textContent === 'Thread thr_0000000000000100'`,
      ),
    'recovered durable Thread identity',
  );
  for (const turnId of [
    'turn_0000000000000099',
    'turn_0000000000000100',
  ]) {
    await waitFor(
      () =>
        evaluate<boolean>(
          `document.querySelector(
            '[aria-label="Durable Turn ${turnId}"]',
          )?.textContent?.includes('Turn ${turnId}') === true`,
        ),
      `recovered durable Turn identity ${turnId}`,
    );
  }
  for (const itemId of [
    'item_0000000000000098',
    'item_0000000000000099',
    'item_0000000000000100',
    'item_0000000000000101',
  ]) {
    await waitForDurableItemIdentity(
      itemId,
      `recovered durable Item identity ${itemId}`,
    );
  }
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Turn failure details"]',
        )?.textContent?.includes(
          'You can send another message to retry.',
        ) === true && document.querySelector(
          '[aria-label="Exact Turn failure kind rateLimited"]',
        )?.textContent === 'rateLimited'`,
      ),
    'recovered Electron Turn failure',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `Array.from(document.querySelectorAll(
          '[aria-label="Agent response"] figure',
        )).some((figure) =>
          figure.textContent?.includes('Language hintTypeScript') === true &&
          figure.textContent?.includes('1 line') === true &&
          figure.querySelector('pre code')?.textContent?.includes(
            'throw new Error',
          ) === true
        )`,
      ),
    'failed Turn fenced-code line count',
  );
  if (
    await evaluate<boolean>(
      `document.body.textContent?.includes(
        'Thinking through the turn',
      ) === true`,
    )
  ) {
    throw new Error(
      'Recovered terminal AgentMessage displayed an active placeholder.',
    );
  }
  await waitFor(
    () =>
      evaluate<boolean>(
        `(() => {
          const activity = document.querySelector(
            '[aria-label="Workspace read complete: recovered/context.txt"]',
          );
          return activity?.getAttribute('data-state') === 'succeeded' &&
            activity.textContent?.includes('25 bytes read') === true &&
            !activity.textContent?.includes('private recovered content') &&
            !activity.textContent?.includes('call_recovered_read') &&
            !activity.querySelector('button, a');
        })()`,
      ),
    'recovered workspace read presentation',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `(() => {
          const activity = document.querySelector(
            '[aria-label="Workspace list complete: recovered/directory"]',
          );
          return activity?.getAttribute('data-state') === 'succeeded' &&
            activity.textContent?.includes('0 entries found') === true &&
            !activity.textContent?.includes('private-entry.txt') &&
            !activity.textContent?.includes('call_recovered_list') &&
            !activity.querySelector('button, a');
        })()`,
      ),
    'recovered workspace list presentation',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `(() => {
          const activity = document.querySelector(
            '[aria-label="Workspace list failed: recovered/missing-directory"]',
          );
          return activity?.getAttribute('role') === 'alert' &&
            activity.getAttribute('data-state') === 'failed' &&
            activity.textContent?.includes('Failure kind notFound') === true &&
            !activity.querySelector('button, a');
        })()`,
      ),
    'recovered failed workspace list presentation',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `(() => {
          const activity = document.querySelector(
            '[aria-label="Workspace search complete: recovered/search-root"]',
          );
          return activity?.getAttribute('data-state') === 'succeeded' &&
            activity.textContent?.includes('More than 200 matches found') === true &&
            activity.textContent?.includes('durable needle') === true &&
            !activity.textContent?.includes('private-recovered-match.txt') &&
            !activity.textContent?.includes('call_recovered_search') &&
            !activity.querySelector('button, a');
        })()`,
      ),
    'recovered workspace search presentation',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `(() => {
          const activity = document.querySelector(
            '[aria-label="Workspace search failed: recovered/unreadable-root"]',
          );
          return activity?.getAttribute('role') === 'alert' &&
            activity.getAttribute('data-state') === 'failed' &&
            activity.textContent?.includes('Failure kind accessDenied') === true &&
            activity.textContent?.includes('permission needle') === true &&
            !activity.querySelector('button, a');
        })()`,
      ),
    'recovered failed workspace search presentation',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `(() => {
          const review = document.querySelector(
            '[aria-label="File change applied: recovered/notes.txt"]',
          );
          const diff = review?.querySelector(
            '[aria-label="Unified diff for recovered/notes.txt"]',
          );
          return review?.getAttribute('role') === 'status' &&
            review.getAttribute('data-state') === 'applied' &&
            review.textContent?.includes('Durable success result recorded') === true &&
            review.textContent?.includes('@@ -1,1 +1,1 @@') === true &&
            review.textContent?.includes('-old') === true &&
            review.textContent?.includes('+new') === true &&
            review.textContent?.includes(${JSON.stringify(fileChangeBeforeSha256)}) === true &&
            review.textContent?.includes(${JSON.stringify(fileChangeAfterSha256)}) === true &&
            diff?.getAttribute('role') === 'region' &&
            review.querySelectorAll('button, a, input, textarea').length === 1;
        })()`,
      ),
    'recovered applied FileChange review',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `(() => {
          const review = document.querySelector(
            '[aria-label="File change outcome unknown: recovered/pending.txt"]',
          );
          return review?.getAttribute('role') === 'alert' &&
            review.getAttribute('data-state') === 'outcomeUnknown' &&
            review.textContent?.includes(
              'A durable proposal exists without a durable result',
            ) === true;
        })()`,
      ),
    'recovered unknown FileChange outcome',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `(() => {
          const activity = document.querySelector(
            '[aria-label="Command approved: /usr/bin/printf"]',
          );
          const attempt = activity?.querySelector(
            '[aria-label="Execution attempt recorded"]',
          );
          const result = activity?.querySelector(
            '[aria-label="Execution result recorded: Command exited with code 7"]',
          );
          return activity?.getAttribute('role') === 'status' &&
            activity.getAttribute('data-state') === 'approved' &&
            attempt?.getAttribute('data-execution-attempt-state') === 'recorded' &&
            result?.getAttribute('role') === 'alert' &&
            result.getAttribute('data-execution-result-state') === 'recorded' &&
            result.getAttribute('data-execution-outcome') === 'exitCode' &&
            activity.textContent?.includes('1 argument') === true &&
            activity.textContent?.includes('Executor invocation is durably recorded') === true &&
            activity.textContent?.includes('12 ms') === true &&
            activity.textContent?.includes('24 B') === true &&
            activity.textContent?.includes('9 B · truncated') === true &&
            activity.textContent?.includes('filesystemReadOnlyV1') === true &&
            activity.textContent?.includes('networkDeniedV1') === true &&
            !activity.textContent?.includes('private-electron-argument') &&
            !activity.querySelector('button, a');
        })()`,
      ),
    'recovered command execution attempt presentation',
  );
  const sendConversationInput = async (input: string): Promise<void> => {
    await evaluate(`(() => {
      const textarea = document.querySelector(
        'textarea[aria-label="Message SugarCode"]',
      );
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error('Conversation textarea not found.');
      }
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, ${JSON.stringify(input)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const button = document.querySelector(
        'button[aria-label="Send message"]',
      );
      if (!(button instanceof HTMLButtonElement) || button.disabled) {
        throw new Error('Conversation send button unavailable.');
      }
      button.click();
    })()`);
  };
  const emitTextTurn = async (
    turnId: string,
    input: string,
    output: string,
    terminal: 'completed' | 'interrupted',
    afterDelta?: () => Promise<void>,
    workspaceSearch?: Readonly<{
      path: string;
      query: string;
      matches: number;
      truncated: boolean;
    }>,
  ): Promise<void> => {
    conversation.handleNotification({
      kind: 'notification',
      method: 'turn/started',
      params: {
        threadId: 'thr_0000000000000100',
        turn: { id: turnId, status: 'inProgress' },
      },
    });
    for (const [method, item] of [
      [
        'item/started',
        { type: 'userMessage', id: `${turnId}/user`, text: input },
      ],
      [
        'item/completed',
        { type: 'userMessage', id: `${turnId}/user`, text: input },
      ],
    ] as const) {
      conversation.handleNotification({
        kind: 'notification',
        method,
        params: {
          threadId: 'thr_0000000000000100',
          turnId,
          item,
        },
      });
    }
    if (workspaceSearch) {
      const call = {
        type: 'toolCall',
        id: `${turnId}/search`,
        callId: `${turnId}/search-call`,
        name: 'workspace/search',
        path: workspaceSearch.path,
        query: workspaceSearch.query,
      } as const;
      const matches = Array.from(
        { length: workspaceSearch.matches },
        (_value, index) => ({
          path: `private-live-match-${index}.txt`,
          line: index + 1,
        }),
      );
      const content = JSON.stringify({
        matches,
        truncated: workspaceSearch.truncated,
      });
      const result = {
        type: 'toolResult',
        id: `${turnId}/search-result`,
        callId: call.callId,
        name: 'workspace/search',
        result: {
          type: 'success',
          content,
          bytes: new TextEncoder().encode(content).byteLength,
        },
      } as const;
      for (const [method, item] of [
        ['item/started', call],
        ['item/completed', call],
        ['item/started', result],
        ['item/completed', result],
      ] as const) {
        conversation.handleNotification({
          kind: 'notification',
          method,
          params: {
            threadId: 'thr_0000000000000100',
            turnId,
            item,
          },
        });
      }
    }
    conversation.handleNotification({
      kind: 'notification',
      method: 'item/started',
      params: {
        threadId: 'thr_0000000000000100',
        turnId,
        item: { type: 'agentMessage', id: `${turnId}/agent`, text: '' },
      },
    });
    if (output) {
      conversation.handleNotification({
        kind: 'notification',
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thr_0000000000000100',
          turnId,
          itemId: `${turnId}/agent`,
          delta: output,
        },
      });
      await afterDelta?.();
    }
    conversation.handleNotification({
      kind: 'notification',
      method: 'item/completed',
      params: {
        threadId: 'thr_0000000000000100',
        turnId,
        item: {
          type: 'agentMessage',
          id: `${turnId}/agent`,
          text: output,
        },
      },
    });
    conversation.handleNotification({
      kind: 'notification',
      method: 'turn/completed',
      params: {
        threadId: 'thr_0000000000000100',
        turn: { id: turnId, status: terminal },
      },
    });
  };

  await sendConversationInput('Desktop exact input 雪');
  await waitFor(
    () => conversation.getSnapshot().phase === 'inProgress',
    'first conversation Turn',
  );
  await emitTextTurn(
    'turn_0000000000000101',
    'Desktop exact input 雪',
    [
      '## Streamed desktop answer',
      '',
      'Use **durable truth**.',
      '',
      '```TSX title="live"',
      'const answer = <Result />;',
      '```',
    ].join('\n'),
    'completed',
    async () => {
      await waitFor(
        () =>
          evaluate<boolean>(
            `document.querySelector(
              '[aria-label="Durable Turn turn_0000000000000101"]',
            )?.textContent?.includes(
              'Turn turn_0000000000000101',
            ) === true`,
          ),
        'live durable Turn identity',
      );
      await waitForDurableItemIdentity(
        'turn_0000000000000101/user',
        'live durable UserMessage Item identity',
      );
      await waitForDurableItemIdentity(
        'turn_0000000000000101/agent',
        'live durable AgentMessage Item identity',
      );
      await waitFor(
        () =>
          evaluate<boolean>(
            `(() => {
              const response = document.querySelector(
                '[aria-label="Agent is responding"]',
              );
              return response?.querySelector('h2')?.textContent ===
                'Streamed desktop answer' &&
                response.querySelector('strong')?.textContent ===
                  'durable truth' &&
                response.querySelector('figure')?.textContent?.includes(
                  'Language hintTSX',
                ) === true &&
                response.querySelector('figure')?.textContent?.includes(
                  '1 line',
                ) === true;
            })()`,
          ),
        'incremental streaming Markdown projection',
      );
    },
    {
      path: 'live/search-root',
      query: 'streamed needle',
      matches: 200,
      truncated: true,
    },
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `Array.from(document.querySelectorAll(
          '[aria-label="Agent response"]',
        )).some((response) =>
          response.querySelector('h2')?.textContent ===
            'Streamed desktop answer' &&
          response.querySelector('strong')?.textContent === 'durable truth' &&
          response.querySelector('figure')?.textContent?.includes(
            'Language hintTSX',
          ) === true &&
          response.querySelector('figure')?.textContent?.includes(
            '1 line',
          ) === true
        )`,
      ),
    'rendered completed Markdown answer',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `(() => {
          const activity = document.querySelector(
            '[aria-label="Workspace search complete: live/search-root"]',
          );
          return activity?.getAttribute('data-state') === 'succeeded' &&
            activity.textContent?.includes('More than 200 matches found') === true &&
            activity.textContent?.includes('streamed needle') === true &&
            !activity.textContent?.includes('private-live-match-0.txt') &&
            !activity.querySelector('button, a');
        })()`,
      ),
    'live workspace search presentation',
  );
  await evaluate('location.reload()');
  await waitFor(
    () =>
      evaluate<boolean>(
        `Array.from(document.querySelectorAll(
          '[aria-label="Agent response"]',
        )).some((response) =>
          response.querySelector('h2')?.textContent ===
            'Streamed desktop answer' &&
          response.querySelector('strong')?.textContent === 'durable truth' &&
          response.querySelector('figure')?.textContent?.includes(
            'Language hintTSX',
          ) === true &&
          response.querySelector('figure')?.textContent?.includes(
            '1 line',
          ) === true
        )`,
      ),
    'completed Markdown snapshot after reload',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Current durable Thread thr_0000000000000100"]',
        )?.textContent === 'Thread thr_0000000000000100'`,
      ),
    'durable Thread identity after Renderer reload',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Durable Turn turn_0000000000000101"]',
        )?.textContent?.includes(
          'Turn turn_0000000000000101',
        ) === true`,
      ),
    'durable Turn identity after Renderer reload',
  );
  await waitForDurableItemIdentity(
    'turn_0000000000000101/user',
    'durable UserMessage Item identity after Renderer reload',
  );
  await waitForDurableItemIdentity(
    'turn_0000000000000101/agent',
    'durable AgentMessage Item identity after Renderer reload',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Turn failure details"]',
        )?.textContent?.includes('The model is rate limited') === true &&
        document.querySelector(
          '[aria-label="Exact Turn failure kind rateLimited"]',
        )?.textContent === 'rateLimited'`,
    ),
    'Turn failure after Renderer reload',
  );
  for (const path of ['recovered/context.txt']) {
    await waitFor(
      () =>
        evaluate<boolean>(
          `document.querySelector(
            '[aria-label="Workspace read complete: ${path}"]',
          )?.getAttribute('data-state') === 'succeeded'`,
        ),
      `workspace read ${path} after Renderer reload`,
    );
  }
  for (const path of ['recovered/directory']) {
    await waitFor(
      () =>
        evaluate<boolean>(
          `document.querySelector(
            '[aria-label="Workspace list complete: ${path}"]',
          )?.getAttribute('data-state') === 'succeeded'`,
        ),
      `workspace list ${path} after Renderer reload`,
    );
  }
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Workspace list failed: recovered/missing-directory"]',
        )?.textContent?.includes('Failure kind notFound') === true`,
      ),
    'failed workspace list after Renderer reload',
  );
  for (const path of ['recovered/search-root', 'live/search-root']) {
    await waitFor(
      () =>
        evaluate<boolean>(
          `document.querySelector(
            '[aria-label="Workspace search complete: ${path}"]',
          )?.getAttribute('data-state') === 'succeeded'`,
        ),
      `workspace search ${path} after Renderer reload`,
    );
  }
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Workspace search failed: recovered/unreadable-root"]',
        )?.textContent?.includes('Failure kind accessDenied') === true`,
      ),
    'failed workspace search after Renderer reload',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Execution result recorded: Command exited with code 7"]',
        )?.getAttribute('data-execution-result-state') === 'recorded'`,
      ),
    'command execution result after Renderer reload',
  );
  await evaluate(`Array.from(document.querySelectorAll(
    '[aria-label="Agent response"]',
  )).find((response) =>
    response.querySelector('h2')?.textContent === 'Streamed desktop answer'
  )?.scrollIntoView({ block: 'start' })`);
  await writeFile(
    path.join(__dirname, 'conversation-light.png'),
    (await capturePageWithRetry('light conversation')).toPNG(),
  );

  await sendConversationInput('Stop this desktop Turn.');
  await waitFor(
    () => conversation.getSnapshot().phase === 'inProgress',
    'second conversation Turn',
  );
  const secondTurnId = 'turn_0000000000000102';
  conversation.handleNotification({
    kind: 'notification',
    method: 'turn/started',
    params: {
      threadId: 'thr_0000000000000100',
      turn: { id: secondTurnId, status: 'inProgress' },
    },
  });
  for (const [method, item] of [
    [
      'item/started',
      {
        type: 'userMessage',
        id: `${secondTurnId}/user`,
        text: 'Stop this desktop Turn.',
      },
    ],
    [
      'item/completed',
      {
        type: 'userMessage',
        id: `${secondTurnId}/user`,
        text: 'Stop this desktop Turn.',
      },
    ],
    [
      'item/started',
      { type: 'agentMessage', id: `${secondTurnId}/agent`, text: '' },
    ],
  ] as const) {
    conversation.handleNotification({
      kind: 'notification',
      method,
      params: {
        threadId: 'thr_0000000000000100',
        turnId: secondTurnId,
        item,
      },
    });
  }
  const stoppingListCall = {
    type: 'toolCall',
    id: `${secondTurnId}/list`,
    callId: `${secondTurnId}/list-call`,
    name: 'workspace/list',
    path: 'stopping/pending-directory',
  } as const;
  for (const method of ['item/started', 'item/completed'] as const) {
    conversation.handleNotification({
      kind: 'notification',
      method,
      params: {
        threadId: 'thr_0000000000000100',
        turnId: secondTurnId,
        item: stoppingListCall,
      },
    });
  }
  await waitFor(
    () =>
      evaluate<boolean>(
        `Boolean(document.querySelector(
          'button[aria-label="Stop current turn"]',
        ))`,
      ),
    'conversation Stop button',
  );
  await evaluate(`document.querySelector(
    'button[aria-label="Stop current turn"]',
  )?.click()`);
  await waitFor(
    () => conversation.getSnapshot().phase === 'stopping',
    'conversation stopping state',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Stopping workspace list: stopping/pending-directory"]',
        )?.getAttribute('data-state') === 'stopping'`,
      ),
    'stopping workspace list presentation',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Durable Turn turn_0000000000000102"]',
        )?.textContent?.includes(
          'Turn turn_0000000000000102',
        ) === true`,
      ),
    'stopping durable Turn identity',
  );
  await waitForDurableItemIdentity(
    `${secondTurnId}/user`,
    'stopping durable UserMessage Item identity',
  );
  await waitForDurableItemIdentity(
    `${secondTurnId}/agent`,
    'stopping durable AgentMessage Item identity',
  );
  conversation.handleNotification({
    kind: 'notification',
    method: 'item/completed',
    params: {
      threadId: 'thr_0000000000000100',
      turnId: secondTurnId,
      item: {
        type: 'agentMessage',
        id: `${secondTurnId}/agent`,
        text: '',
      },
    },
  });
  conversation.handleNotification({
    kind: 'notification',
    method: 'turn/completed',
    params: {
      threadId: 'thr_0000000000000100',
      turn: { id: secondTurnId, status: 'interrupted' },
    },
  });
  resolveInterrupt?.();
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.body.textContent?.includes('Turn stopped') === true`,
      ),
    'interrupted Turn presentation',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Workspace list stopped: stopping/pending-directory"]',
        )?.getAttribute('data-state') === 'interrupted'`,
      ),
    'interrupted workspace list presentation',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Durable Turn turn_0000000000000102"]',
        )?.textContent?.includes(
          'Turn turn_0000000000000102',
        ) === true`,
      ),
    'interrupted durable Turn identity',
  );
  await waitForDurableItemIdentity(
    `${secondTurnId}/agent`,
    'interrupted durable AgentMessage Item identity',
  );

  await sendConversationInput('Preserve an uncertain partial response.');
  await waitFor(
    () => conversation.getSnapshot().phase === 'inProgress',
    'third conversation Turn',
  );
  const thirdTurnId = 'turn_0000000000000103';
  conversation.handleNotification({
    kind: 'notification',
    method: 'turn/started',
    params: {
      threadId: 'thr_0000000000000100',
      turn: { id: thirdTurnId, status: 'inProgress' },
    },
  });
  conversation.handleNotification({
    kind: 'notification',
    method: 'item/started',
    params: {
      threadId: 'thr_0000000000000100',
      turnId: thirdTurnId,
      item: {
        type: 'agentMessage',
        id: `${thirdTurnId}/agent`,
        text: '',
      },
    },
  });
  const uncertainSearchCall = {
    type: 'toolCall',
    id: `${thirdTurnId}/search`,
    callId: `${thirdTurnId}/search-call`,
    name: 'workspace/search',
    path: 'uncertain/search-root',
    query: 'partial needle',
  } as const;
  for (const method of ['item/started', 'item/completed'] as const) {
    conversation.handleNotification({
      kind: 'notification',
      method,
      params: {
        threadId: 'thr_0000000000000100',
        turnId: thirdTurnId,
        item: uncertainSearchCall,
      },
    });
  }
  conversation.handleNotification({
    kind: 'notification',
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thr_0000000000000100',
      turnId: thirdTurnId,
      itemId: `${thirdTurnId}/agent`,
      delta: [
        'Exact **partial** output before transport loss.',
        '',
        '```Rust',
        'fn uncertain() {',
      ].join('\n'),
    },
  });
  conversation.transportClosed();
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Agent response status is unavailable"]',
        )?.textContent?.includes(
          'Exact **partial** output before transport loss.',
        ) === true && !document.querySelector(
          '[aria-label="Agent response status is unavailable"] strong',
        ) && !document.querySelector(
          '[aria-label="Agent response status is unavailable"] figure',
        ) && !document.querySelector(
          '[aria-label="Agent response status is unavailable"] pre',
        )`,
      ),
    'uncertain Agent response',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Workspace search status unavailable: uncertain/search-root"]',
        )?.getAttribute('data-state') === 'uncertain'`,
      ),
    'uncertain workspace search presentation',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Durable Turn turn_0000000000000103"]',
        )?.textContent?.includes(
          'Turn turn_0000000000000103',
        ) === true`,
      ),
    'transport-uncertain durable Turn identity',
  );
  await waitForDurableItemIdentity(
    `${thirdTurnId}/agent`,
    'transport-uncertain durable AgentMessage Item identity',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `Array.from(document.querySelectorAll('figure')).some((figure) =>
          figure.textContent?.includes('Language hintTSX') === true &&
          figure.textContent?.includes('1 line') === true
        )`,
      ),
    'completed fenced-code line count after transport loss',
  );
  if (
    await evaluate<boolean>(
      `Boolean(document.querySelector(
        '[aria-label="Agent is responding"]',
      ))`,
    )
  ) {
    throw new Error(
      'Transport loss retained an active Agent response indicator.',
    );
  }
  await evaluate('location.reload()');
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Agent response status is unavailable"]',
        )?.textContent?.includes('Final status unavailable') === true`,
      ),
    'uncertain response after Renderer reload',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Workspace search status unavailable: uncertain/search-root"]',
        )?.getAttribute('data-state') === 'uncertain'`,
      ),
    'uncertain workspace search after Renderer reload',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Durable Turn turn_0000000000000103"]',
        )?.textContent?.includes(
          'Turn turn_0000000000000103',
        ) === true`,
      ),
    'transport-uncertain durable Turn identity after reload',
  );
  await waitForDurableItemIdentity(
    `${thirdTurnId}/agent`,
    'transport-uncertain durable AgentMessage Item identity after reload',
  );

  await waitFor(
    () =>
      evaluate<boolean>(
        `Array.from(document.querySelectorAll('[role="status"]')).some(
          (element) => element.textContent === 'Disabled for this session',
        )`,
      ),
    'MCP disabled session',
  );
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((candidate) =>
        candidate.textContent?.includes('alpha') === true &&
        candidate.getClientRects().length > 0
      );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('MCP alpha selection was not visible.');
    }
    button.click();
  })()`);
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((candidate) =>
        candidate.textContent?.trim() === 'Enable' &&
        candidate.getClientRects().length > 0
      );
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      throw new Error('MCP Enable action was not available.');
    }
    button.click();
  })()`);
  await waitFor(
    () =>
      mcpRestarts.some(
        (serverIds) =>
          serverIds.length === 1 && serverIds[0] === 'alpha',
      ),
    'MCP session enable',
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `Array.from(document.querySelectorAll('[role="status"]')).some(
          (element) => element.textContent === 'Enabled for this session',
        )`,
      ),
    'MCP enabled presentation',
  );

  mcpApprovals.handleServerRequest(
    mcpRequest('approval/mcp-electron-approve'),
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector('[role="alertdialog"]')
          ?.textContent?.includes('Allow this MCP call once?') === true`,
      ),
    'MCP approval dialog',
  );
  const lightMcpDialogBackground = await evaluate<string>(
    `getComputedStyle(
      document.querySelector('[role="alertdialog"]'),
    ).backgroundColor`,
  );
  const mcpRendered = await evaluate<{
    text: string;
    focused: string;
    detailsFocusable: boolean;
  }>(`(() => {
    const dialog = document.querySelector('[role="alertdialog"]');
    const details = document.querySelector(
      '[aria-label="MCP approval details"]',
    );
    return {
      text: dialog?.textContent ?? '',
      focused: document.activeElement?.textContent ?? '',
      detailsFocusable:
        details instanceof HTMLElement && details.tabIndex === 0,
    };
  })()`);
  if (
    !mcpRendered.text.includes(
      '{"nested":{"exact":"雪"},"query":"sugar"}',
    ) ||
    !mcpRendered.text.includes('mcp__alpha__lookup') ||
    !mcpRendered.text.includes('42 bytes') ||
    !mcpRendered.text.includes('c'.repeat(64)) ||
    !mcpRendered.text.includes('d'.repeat(64)) ||
    mcpRendered.focused !== 'Deny' ||
    !mcpRendered.detailsFocusable
  ) {
    throw new Error('Electron MCP approval did not preserve its UI contract.');
  }
  await writeFile(
    path.join(__dirname, 'mcp-approval-light.png'),
    (await capturePageWithRetry('light MCP approval dialog')).toPNG(),
  );
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === 'Approve once');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('MCP approve button not found.');
    }
    button.click();
  })()`);
  await waitFor(
    () =>
      mcpWrittenDecisions.some(
        (entry) =>
          entry.id === 'approval/mcp-electron-approve' &&
          entry.decision === 'approved',
      ),
    'MCP approved response',
  );
  mcpApprovals.handleNotification(
    mcpCompletion('approval/mcp-electron-approve', 'approved'),
  );

  mcpApprovals.handleServerRequest(
    mcpRequest('approval/mcp-electron-escape'),
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector('[role="alertdialog"]')
          ?.textContent?.includes('Allow this MCP call once?') === true`,
      ),
    'MCP Escape denial dialog',
  );
  await waitForAnimationFrame();
  await evaluate(`document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  )`);
  await waitFor(
    () =>
      mcpWrittenDecisions.some(
        (entry) =>
          entry.id === 'approval/mcp-electron-escape' &&
          entry.decision === 'denied',
      ),
    'MCP Escape denial',
  );
  mcpApprovals.handleNotification(
    mcpCompletion('approval/mcp-electron-escape', 'denied'),
  );

  mcpApprovals.handleServerRequest(
    mcpRequest('approval/mcp-electron-reload'),
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector('[role="alertdialog"]')
          ?.textContent?.includes('Allow this MCP call once?') === true`,
      ),
    'MCP reload denial dialog',
  );
  await evaluate('location.reload()');
  await waitFor(
    () =>
      mcpWrittenDecisions.some(
        (entry) =>
          entry.id === 'approval/mcp-electron-reload' &&
          entry.decision === 'denied',
      ),
    'MCP reload default denial',
  );
  mcpApprovals.handleNotification(
    mcpCompletion('approval/mcp-electron-reload', 'denied'),
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `Array.from(document.querySelectorAll('[role="status"]')).some(
          (element) => element.textContent === 'Enabled for this session',
        )`,
      ),
    'MCP session retained after Renderer reload',
  );

  controller.handleServerRequest(request('approval/electron-approve'));
  await waitFor(
    () =>
      evaluate<boolean>(
        'Boolean(document.querySelector(\'[role="alertdialog"]\'))',
      ),
    'approval dialog',
  );
  const rendered = await evaluate<{
    text: string;
    focused: string;
    argumentList: boolean;
    scrollable: boolean;
  }>(`(() => {
    const dialog = document.querySelector('[role="alertdialog"]');
    const details = document.querySelector(
      '[aria-label="Command approval details"]',
    );
    return {
      text: dialog?.textContent ?? '',
      focused: document.activeElement?.textContent ?? '',
      argumentList: Boolean(document.querySelector(
        '[aria-label="Command arguments in argv order"]',
      )),
      scrollable: details instanceof HTMLElement
        ? details.scrollHeight > details.clientHeight
        : false,
    };
  })()`);
  if (
    !rendered.text.includes('"/usr/bin/printf"') ||
    !rendered.text.includes('filesystemReadOnlyV1') ||
    !rendered.text.includes('networkDeniedV1') ||
    !rendered.argumentList ||
    !rendered.scrollable ||
    rendered.focused !== 'Deny'
  ) {
    throw new Error('Electron approval dialog did not preserve its UI contract.');
  }
  const screenshot = await capturePageWithRetry('light approval dialog');
  await writeFile(
    path.join(__dirname, 'command-approval-light.png'),
    screenshot.toPNG(),
  );
  const lightDialogBackground = await evaluate<string>(
    `getComputedStyle(
      document.querySelector('[role="alertdialog"]'),
    ).backgroundColor`,
  );
  const riskReached = await evaluate<boolean>(`(() => {
    const details = document.querySelector(
      '[aria-label="Command approval details"]',
    );
    const risk = document.querySelector('#approval-risk-label');
    if (!(details instanceof HTMLElement) || !(risk instanceof HTMLElement)) {
      return false;
    }
    details.scrollTop = details.scrollHeight;
    const detailsRect = details.getBoundingClientRect();
    const riskRect = risk.getBoundingClientRect();
    return riskRect.top >= detailsRect.top && riskRect.bottom <= detailsRect.bottom;
  })()`);
  if (!riskReached) {
    throw new Error('Electron approval details did not expose the risk section.');
  }
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === 'Approve once & run');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Approve button not found.');
    }
    button.click();
  })()`);
  await waitFor(
    () =>
      writtenDecisions.some(
        (entry) =>
          entry.id === 'approval/electron-approve' &&
          entry.decision === 'approved',
      ),
    'approved response',
  );
  if (controller.getSnapshot().status !== 'pending') {
    throw new Error('UI response was treated as a durable decision.');
  }
  controller.handleNotification(
    completion('approval/electron-approve', 'approved'),
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `Array.from(document.querySelectorAll('[role="status"]')).some(
          (element) => element.textContent?.includes(
            'recorded decision is complete',
          ) === true,
        )`,
      ),
    'durable approved status',
  );
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === 'Use dark theme');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Theme button not found.');
    }
    button.click();
  })()`);
  await waitFor(
    () =>
      evaluate<boolean>(
        "document.documentElement.classList.contains('dark')",
      ),
    'dark theme',
  );
  await writeFile(
    path.join(__dirname, 'conversation-dark.png'),
    (await capturePageWithRetry('dark conversation')).toPNG(),
  );

  mcpApprovals.handleServerRequest(
    mcpRequest('approval/mcp-electron-dark'),
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector('[role="alertdialog"]')
          ?.textContent?.includes('Allow this MCP call once?') === true`,
      ),
    'dark MCP approval dialog',
  );
  const darkMcpDialogBackground = await evaluate<string>(
    `getComputedStyle(
      document.querySelector('[role="alertdialog"]'),
    ).backgroundColor`,
  );
  if (darkMcpDialogBackground === lightMcpDialogBackground) {
    throw new Error('Electron MCP approval did not apply dark tokens.');
  }
  await writeFile(
    path.join(__dirname, 'mcp-approval-dark.png'),
    (await capturePageWithRetry('dark MCP approval dialog')).toPNG(),
  );
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === 'Deny');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('MCP deny button not found.');
    }
    button.click();
  })()`);
  await waitFor(
    () =>
      mcpWrittenDecisions.some(
        (entry) =>
          entry.id === 'approval/mcp-electron-dark' &&
          entry.decision === 'denied',
      ),
    'dark MCP denial',
  );
  mcpApprovals.handleNotification(
    mcpCompletion('approval/mcp-electron-dark', 'denied'),
  );

  controller.handleServerRequest(request('approval/electron-reload'));
  await waitFor(
    () =>
      evaluate<boolean>(
        'Boolean(document.querySelector(\'[role="alertdialog"]\'))',
    ),
    'reload approval dialog',
  );
  await waitForAnimationFrame();
  const darkDialogBackground = await evaluate<string>(
    `getComputedStyle(
      document.querySelector('[role="alertdialog"]'),
    ).backgroundColor`,
  );
  if (darkDialogBackground === lightDialogBackground) {
    throw new Error('Electron approval dialog did not apply dark tokens.');
  }
  await writeFile(
    path.join(__dirname, 'command-approval-dark.png'),
    (await capturePageWithRetry('dark approval dialog')).toPNG(),
  );
  await evaluate('location.reload()');
  await waitFor(
    () =>
      writtenDecisions.some(
        (entry) =>
          entry.id === 'approval/electron-reload' &&
          entry.decision === 'denied',
      ),
    'reload denial',
  );
  controller.handleNotification(
    completion('approval/electron-reload', 'denied'),
  );
  await waitFor(
    () =>
      evaluate<boolean>(
        `Array.from(document.querySelectorAll('[role="status"]')).some(
          (element) => element.textContent?.includes(
            'Nothing was run',
          ) === true,
        )`,
      ),
    'durable denied status after reload',
  );

  await evaluate('window.sugarcode.getCommandApprovalState()');
  controller.handleServerRequest(request('approval/electron-close'));
  await waitFor(
    () =>
      evaluate<boolean>(
        'Boolean(document.querySelector(\'[role="alertdialog"]\'))',
      ),
    'close approval dialog',
  );
  window.destroy();
  await waitFor(
    () =>
      writtenDecisions.some(
        (entry) =>
          entry.id === 'approval/electron-close' &&
          entry.decision === 'denied',
      ),
    'window close denial',
  );

  disposeApprovalIpc();
  disposeConversationIpc();
  disposeMcpIpc();
  disposeModelConfigIpc();
  ipcMain.removeHandler(CONNECTION_STATE_GET_CHANNEL);
  controller.shutdown();
  mcpApprovals.shutdown();
  if (lifecycleFailures.length > 0) {
    throw new Error(
      `Unexpected lifecycle failures: ${lifecycleFailures.join(', ')}`,
    );
  }
  process.stdout.write(
    `${resultPrefix}${JSON.stringify({
      rendered,
      writtenDecisions,
      mcpWrittenDecisions,
      mcpRestarts,
      conversationInputs,
      interruptRequests,
    })}\n`,
  );
};

void app
  .whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error: unknown) => {
    const message =
      error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    app.exit(1);
  });
