import {
  app,
  BrowserWindow,
  ipcMain,
} from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CommandApprovalController } from '@/main/app-server/command-approval-controller';
import { registerCommandApprovalIpc } from '@/main/app-server/command-approval-ipc';
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

  await window.loadFile(rendererPath);
  window.show();
  await evaluate('window.sugarcode.getCommandApprovalState()');
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
  await waitForAnimationFrame();
  const screenshot = await window.webContents.capturePage();
  if (screenshot.isEmpty()) {
    throw new Error('Electron approval dialog did not paint.');
  }
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
    (await window.webContents.capturePage()).toPNG(),
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
