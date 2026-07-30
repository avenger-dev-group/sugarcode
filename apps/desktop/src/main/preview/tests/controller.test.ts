import { EventEmitter } from 'node:events';

import type { BrowserWindow, Dialog, Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceStateSnapshot } from '@/shared/workspace';

import { PreviewController } from '../controller';

const sessionId = '12345678-1234-4123-8123-123456789abc';

class FakeWebContents extends EventEmitter {
  readonly reload = vi.fn();
  readonly stop = vi.fn();
  readonly setWindowOpenHandler = vi.fn();
  readonly navigationHistory = {
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
}

class FakeBrowserWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  readonly loadURL = vi.fn(async () => undefined);
  readonly setMenu = vi.fn();
  readonly setTitle = vi.fn();
  readonly show = vi.fn(() => {
    this.visible = true;
  });
  readonly hide = vi.fn(() => {
    this.visible = false;
  });
  readonly focus = vi.fn();
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
  });
  private destroyed = false;
  private visible = false;

  isDestroyed = (): boolean => this.destroyed;
  isVisible = (): boolean => this.visible;
}

class FakeSession extends EventEmitter {
  readonly clearStorageData = vi.fn(async () => undefined);
  readonly closeAllConnections = vi.fn(async () => undefined);
  readonly setProxy = vi.fn(async () => undefined);
  readonly setPermissionCheckHandler = vi.fn();
  readonly setPermissionRequestHandler = vi.fn();
  readonly setDevicePermissionHandler = vi.fn();
  beforeRequest:
    | ((
        details: {
          url: string;
          method: string;
          resourceType: string;
        },
        callback: (result: { cancel: boolean }) => void,
      ) => void)
    | null = null;
  headersReceived:
    | ((
        details: { responseHeaders?: Record<string, string[]> },
        callback: (result: {
          responseHeaders?: Record<string, string[]>;
        }) => void,
      ) => void)
    | null = null;
  readonly webRequest = {
    onBeforeRequest: vi.fn(
      (
        filterOrListener: unknown,
        listener?: FakeSession['beforeRequest'],
      ) => {
        this.beforeRequest =
          typeof filterOrListener === 'function'
            ? (filterOrListener as FakeSession['beforeRequest'])
            : listener ?? null;
      },
    ),
    onHeadersReceived: vi.fn(
      (
        filterOrListener: unknown,
        listener?: FakeSession['headersReceived'],
      ) => {
        this.headersReceived =
          typeof filterOrListener === 'function'
            ? (filterOrListener as FakeSession['headersReceived'])
            : listener ?? null;
      },
    ),
  };
}

const fixture = (confirmationResponse = 1) => {
  let workspace: WorkspaceStateSnapshot = {
    revision: 1,
    generation: 4,
    status: 'ready',
    name: 'preview-project',
  };
  let approvalPending = false;
  const browserWindow = new FakeBrowserWindow();
  const browserSession = new FakeSession();
  const mainWindow = {
    isDestroyed: () => false,
  } as BrowserWindow;
  const dialog = {
    showMessageBox: vi.fn(async () => ({
      response: confirmationResponse,
      checkboxChecked: false,
    })),
  } as unknown as Pick<Dialog, 'showMessageBox'>;
  const createBrowserWindow = vi.fn(
    () => browserWindow as unknown as BrowserWindow,
  );
  const controller = new PreviewController({
    dialog,
    getMainWindow: () => mainWindow,
    getWorkspaceState: () => workspace,
    isApprovalPending: () => approvalPending,
    createBrowserWindow,
    getSession: () => browserSession as unknown as Session,
    createSessionId: () => sessionId,
    loadTimeoutMs: 100,
  });
  return {
    browserSession,
    browserWindow,
    controller,
    createBrowserWindow,
    dialog,
    setApprovalPending: (pending: boolean) => {
      approvalPending = pending;
    },
    setWorkspace: (snapshot: WorkspaceStateSnapshot) => {
      workspace = snapshot;
    },
  };
};

describe('PreviewController', () => {
  it('does not install network authority when native confirmation is cancelled', async () => {
    const test = fixture(0);
    await expect(
      test.controller.open({
        generation: 4,
        url: 'http://127.0.0.1:4173/',
      }),
    ).resolves.toEqual({ accepted: false, reason: 'cancelled' });
    expect(test.createBrowserWindow).not.toHaveBeenCalled();
    expect(test.browserSession.setProxy).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot()).toEqual({
      revision: 0,
      status: 'closed',
    });
  });

  it('installs policy before loading and exposes only a bounded preview session', async () => {
    const test = fixture();
    await expect(
      test.controller.open({
        generation: 4,
        url: 'http://127.0.0.1:4173/app',
      }),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });

    expect(test.browserSession.clearStorageData).toHaveBeenCalled();
    expect(test.browserSession.setProxy).toHaveBeenCalledWith({
      mode: 'direct',
    });
    expect(test.browserSession.setPermissionCheckHandler).toHaveBeenCalled();
    expect(
      test.browserSession.setPermissionRequestHandler,
    ).toHaveBeenCalled();
    expect(test.browserSession.setDevicePermissionHandler).toHaveBeenCalled();
    expect(test.createBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        show: false,
        webPreferences: expect.objectContaining({
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          devTools: false,
          webviewTag: false,
          disableDialogs: true,
          javascript: false,
          partition: `preview-${sessionId}`,
        }),
      }),
    );
    expect(test.browserWindow.loadURL).toHaveBeenCalledWith(
      'http://127.0.0.1:4173/app',
    );
    expect(test.controller.getSnapshot()).toMatchObject({
      status: 'ready',
      generation: 4,
      sessionId,
      origin: 'http://127.0.0.1:4173',
      visible: true,
    });
  });

  it('denies cross-origin, write, frame, and WebSocket requests', async () => {
    const test = fixture();
    await test.controller.open({
      generation: 4,
      url: 'http://127.0.0.1:4173/',
    });
    const decide = (
      url: string,
      method: string,
      resourceType: string,
    ): boolean => {
      let cancelled = false;
      test.browserSession.beforeRequest?.(
        { url, method, resourceType },
        (result) => {
          cancelled = result.cancel;
        },
      );
      return cancelled;
    };

    expect(
      decide('http://127.0.0.1:4173/app.js', 'GET', 'script'),
    ).toBe(false);
    expect(
      decide('http://127.0.0.1:4174/', 'GET', 'mainFrame'),
    ).toBe(true);
    expect(
      decide('http://127.0.0.1:4173/api', 'POST', 'xhr'),
    ).toBe(true);
    expect(
      decide('ws://127.0.0.1:4173/', 'GET', 'webSocket'),
    ).toBe(true);
    expect(
      decide('http://127.0.0.1:4173/frame', 'GET', 'subFrame'),
    ).toBe(true);
  });

  it('hides for approvals, rejects showing while pending, and clears on close', async () => {
    const test = fixture();
    await test.controller.open({
      generation: 4,
      url: 'http://127.0.0.1:4173/',
    });
    test.controller.hideForApproval();
    expect(test.browserWindow.hide).toHaveBeenCalled();
    expect(test.controller.getSnapshot()).toMatchObject({
      status: 'ready',
      visible: false,
    });

    test.setApprovalPending(true);
    expect(
      test.controller.show({ generation: 4, sessionId }),
    ).toEqual({ accepted: false, reason: 'busy' });
    test.setApprovalPending(false);
    expect(
      test.controller.show({ generation: 4, sessionId }),
    ).toEqual({ accepted: true, reason: 'accepted' });

    await expect(
      test.controller.close({ generation: 4, sessionId }),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    expect(test.browserWindow.destroy).toHaveBeenCalled();
    expect(
      test.browserSession.setPermissionCheckHandler,
    ).toHaveBeenLastCalledWith(null);
    expect(test.browserSession.closeAllConnections).toHaveBeenCalled();
    expect(test.controller.getSnapshot()).toMatchObject({
      status: 'closed',
    });
  });

  it('rechecks workspace generation after confirmation', async () => {
    const test = fixture();
    vi.mocked(test.dialog.showMessageBox).mockImplementationOnce(
      async () => {
        test.setWorkspace({
          revision: 2,
          generation: 5,
          status: 'ready',
          name: 'other',
        });
        return { response: 1, checkboxChecked: false };
      },
    );
    await expect(
      test.controller.open({
        generation: 4,
        url: 'http://127.0.0.1:4173/',
      }),
    ).resolves.toEqual({ accepted: false, reason: 'stale' });
    expect(test.createBrowserWindow).not.toHaveBeenCalled();
  });

  it('clears the isolated session when browser creation fails', async () => {
    const test = fixture();
    test.createBrowserWindow.mockImplementationOnce(() => {
      throw new Error('browser unavailable');
    });
    await expect(
      test.controller.open({
        generation: 4,
        url: 'http://127.0.0.1:4173/',
      }),
    ).resolves.toEqual({ accepted: false, reason: 'failed' });
    expect(test.browserSession.closeAllConnections).toHaveBeenCalled();
    expect(test.controller.getSnapshot()).toMatchObject({
      status: 'failed',
      error: 'policyUnavailable',
    });
  });
});
