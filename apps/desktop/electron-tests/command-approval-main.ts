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
import {
  CONNECTION_STATE_GET_CHANNEL,
} from '@/shared/connection';

type WrittenDecision = Readonly<{
  id: string | number;
  decision: 'approved' | 'denied';
}>;

const resultPrefix = 'SUGARCODE_ELECTRON_RESULT:';
const writtenDecisions: WrittenDecision[] = [];
const lifecycleFailures: string[] = [];
const conversationInputs: string[] = [];
const interruptRequests: string[] = [];
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
  let turnSequence = 0;
  let resolveInterrupt: (() => void) | null = null;
  const conversationRpc: ConversationRpc = {
    findLatestActiveThread: async () => 'thr_0000000000000100',
    resumeThread: async () => ({
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
              type: 'agentMessage',
              id: 'item_0000000000000099',
              text: '## Recovered Electron answer\n\n- Durable restart item',
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
              text: '',
            },
          ],
          error: { kind: 'rateLimited', retryable: true },
        },
      ],
    }),
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
      }
    },
  );
  window.webContents.on('render-process-gone', () => {
    controller.surfaceUnavailable();
  });
  window.once('closed', () => {
    controller.surfaceUnavailable();
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

  await window.loadFile(rendererPath);
  window.show();
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
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Turn failure details"]',
        )?.textContent?.includes(
          'You can send another message to retry.',
        ) === true`,
      ),
    'recovered Electron Turn failure',
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
      [
        'item/started',
        { type: 'agentMessage', id: `${turnId}/agent`, text: '' },
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
    '## Streamed desktop answer\n\nUse **durable truth**.',
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
                  'durable truth';
            })()`,
          ),
        'incremental streaming Markdown projection',
      );
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
          response.querySelector('strong')?.textContent === 'durable truth'
        )`,
      ),
    'rendered completed Markdown answer',
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
          response.querySelector('strong')?.textContent === 'durable truth'
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
  await waitFor(
    () =>
      evaluate<boolean>(
        `document.querySelector(
          '[aria-label="Turn failure details"]',
        )?.textContent?.includes('The model is rate limited') === true`,
    ),
    'Turn failure after Renderer reload',
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
          '[aria-label="Durable Turn turn_0000000000000102"]',
        )?.textContent?.includes(
          'Turn turn_0000000000000102',
        ) === true`,
      ),
    'stopping durable Turn identity',
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
          '[aria-label="Durable Turn turn_0000000000000102"]',
        )?.textContent?.includes(
          'Turn turn_0000000000000102',
        ) === true`,
      ),
    'interrupted durable Turn identity',
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
  conversation.handleNotification({
    kind: 'notification',
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thr_0000000000000100',
      turnId: thirdTurnId,
      itemId: `${thirdTurnId}/agent`,
      delta: 'Exact **partial** output before transport loss.',
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
        )`,
      ),
    'uncertain Agent response',
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
          '[aria-label="Durable Turn turn_0000000000000103"]',
        )?.textContent?.includes(
          'Turn turn_0000000000000103',
        ) === true`,
      ),
    'transport-uncertain durable Turn identity after reload',
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
  ipcMain.removeHandler(CONNECTION_STATE_GET_CHANNEL);
  controller.shutdown();
  if (lifecycleFailures.length > 0) {
    throw new Error(
      `Unexpected lifecycle failures: ${lifecycleFailures.join(', ')}`,
    );
  }
  process.stdout.write(
    `${resultPrefix}${JSON.stringify({
      rendered,
      writtenDecisions,
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
