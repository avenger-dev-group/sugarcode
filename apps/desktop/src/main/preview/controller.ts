import {
  BrowserWindow,
  session,
  type Dialog,
  type Session,
} from 'electron';
import { randomUUID } from 'node:crypto';

import type {
  PreviewActionReason,
  PreviewActionResult,
  PreviewFailure,
  PreviewOpenRequest,
  PreviewSessionRequest,
  PreviewStateSnapshot,
} from '@/shared/preview';
import type { WorkspaceStateSnapshot } from '@/shared/workspace';

import {
  isAllowedPreviewRequest,
  parsePreviewLocation,
  type PreviewLocation,
} from './url';

const INITIAL_LOAD_TIMEOUT_MS = 15_000;
const PREVIEW_TITLE = 'SugarCode Static Preview';
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "worker-src 'none'",
].join('; ');

type DialogBoundary = Pick<Dialog, 'showMessageBox'>;

type PreviewControllerOptions = Readonly<{
  dialog: DialogBoundary;
  getMainWindow: () => BrowserWindow | null;
  getWorkspaceState: () => WorkspaceStateSnapshot;
  isApprovalPending: () => boolean;
  createBrowserWindow?: (
    options: Electron.BrowserWindowConstructorOptions,
  ) => BrowserWindow;
  getSession?: (partition: string) => Session;
  createSessionId?: () => string;
  loadTimeoutMs?: number;
}>;

type Listener = (snapshot: PreviewStateSnapshot) => void;
type PreviewStateWithoutRevision =
  PreviewStateSnapshot extends infer Snapshot
    ? Snapshot extends PreviewStateSnapshot
      ? Omit<Snapshot, 'revision'>
      : never
    : never;

type ActivePreview = {
  generation: number;
  sessionId: string;
  location: PreviewLocation;
  browserWindow: BrowserWindow;
  browserSession: Session;
};

const actionResult = (
  reason: PreviewActionReason,
): PreviewActionResult => ({
  accepted: reason === 'accepted',
  reason,
});

const withTimeout = async <Value>(
  promise: Promise<Value>,
  milliseconds: number,
): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Preview load timed out.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export class PreviewController {
  private readonly listeners = new Set<Listener>();
  private readonly createBrowserWindow: NonNullable<
    PreviewControllerOptions['createBrowserWindow']
  >;
  private readonly getSession: NonNullable<
    PreviewControllerOptions['getSession']
  >;
  private readonly createSessionId: NonNullable<
    PreviewControllerOptions['createSessionId']
  >;
  private readonly loadTimeoutMs: number;
  private revision = 0;
  private operationActive = false;
  private active: ActivePreview | null = null;
  private snapshot: PreviewStateSnapshot = {
    revision: 0,
    status: 'closed',
  };

  constructor(private readonly options: PreviewControllerOptions) {
    this.createBrowserWindow =
      options.createBrowserWindow ??
      ((windowOptions) => new BrowserWindow(windowOptions));
    this.getSession =
      options.getSession ??
      ((partition) => session.fromPartition(partition, { cache: false }));
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.loadTimeoutMs = options.loadTimeoutMs ?? INITIAL_LOAD_TIMEOUT_MS;
  }

  getSnapshot = (): PreviewStateSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open = async (
    request: PreviewOpenRequest,
  ): Promise<PreviewActionResult> => {
    if (this.operationActive) {
      return actionResult('busy');
    }
    const location = parsePreviewLocation(request.url);
    if (!location) {
      return actionResult('invalid');
    }
    const initialWorkspace = this.options.getWorkspaceState();
    if (request.generation !== initialWorkspace.generation) {
      return actionResult('stale');
    }
    if (
      initialWorkspace.status !== 'ready' ||
      this.options.isApprovalPending()
    ) {
      return actionResult('unavailable');
    }
    const mainWindow = this.options.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return actionResult('unavailable');
    }

    this.operationActive = true;
    try {
      const confirmation = await this.options.dialog.showMessageBox(
        mainWindow,
        {
          type: 'warning',
          buttons: ['Cancel', 'Open local preview'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Open local preview?',
          message: `Open static content from ${location.origin}?`,
          detail:
            'Page scripts are disabled. SugarCode will allow GET and HEAD requests only to this exact local origin. Other hosts, ports, writes, downloads, popups, frames, permissions, and WebSockets stay blocked. GET requests are not guaranteed to be side-effect free by the server.',
        },
      );
      if (confirmation.response !== 1) {
        return actionResult('cancelled');
      }
      const confirmedWorkspace = this.options.getWorkspaceState();
      if (request.generation !== confirmedWorkspace.generation) {
        return actionResult('stale');
      }
      if (
        confirmedWorkspace.status !== 'ready' ||
        this.options.isApprovalPending()
      ) {
        return actionResult('unavailable');
      }

      await this.closeActive(false);
      const sessionId = this.createSessionId();
      const partition = `preview-${sessionId}`;
      let browserSession: Session;
      try {
        browserSession = this.getSession(partition);
      } catch {
        this.publishFailure(
          request.generation,
          location,
          'policyUnavailable',
        );
        return actionResult('failed');
      }
      try {
        await this.installSessionPolicy(browserSession, location);
      } catch {
        await this.clearSession(browserSession);
        this.publishFailure(
          request.generation,
          location,
          'policyUnavailable',
        );
        return actionResult('failed');
      }

      this.publish({
        status: 'opening',
        generation: request.generation,
        sessionId,
        url: location.url,
        origin: location.origin,
        visible: false,
      });
      let browserWindow: BrowserWindow;
      try {
        browserWindow = this.createBrowserWindow({
          parent: mainWindow,
          show: false,
          width: 1_120,
          height: 760,
          minWidth: 640,
          minHeight: 420,
          autoHideMenuBar: true,
          backgroundColor: '#111315',
          title: PREVIEW_TITLE,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            devTools: false,
            webviewTag: false,
            javascript: false,
            disableDialogs: true,
            navigateOnDragDrop: false,
            partition,
            spellcheck: false,
          },
        });
      } catch {
        await this.clearSession(browserSession);
        this.publishFailure(
          request.generation,
          location,
          'policyUnavailable',
        );
        return actionResult('failed');
      }
      const active: ActivePreview = {
        generation: request.generation,
        sessionId,
        location,
        browserWindow,
        browserSession,
      };
      this.active = active;
      try {
        this.installWindowPolicy(active);
      } catch {
        await this.failActive(active, 'policyUnavailable');
        return actionResult('failed');
      }

      try {
        await withTimeout(
          browserWindow.loadURL(location.url),
          this.loadTimeoutMs,
        );
      } catch {
        if (this.active === active) {
          await this.failActive(active, 'loadFailed');
        }
        return actionResult('failed');
      }
      if (
        this.active !== active ||
        this.options.getWorkspaceState().generation !== request.generation ||
        this.options.getWorkspaceState().status !== 'ready'
      ) {
        await this.closeActive(true);
        return actionResult('stale');
      }
      browserWindow.show();
      this.publishReady(active, true);
      return actionResult('accepted');
    } finally {
      this.operationActive = false;
    }
  };

  show = (request: PreviewSessionRequest): PreviewActionResult => {
    const active = this.getMatchingActive(request);
    if (!active) {
      return actionResult(this.isStale(request) ? 'stale' : 'unavailable');
    }
    if (this.options.isApprovalPending()) {
      return actionResult('busy');
    }
    active.browserWindow.show();
    active.browserWindow.focus();
    this.publishReady(active, true);
    return actionResult('accepted');
  };

  reload = (request: PreviewSessionRequest): PreviewActionResult => {
    const active = this.getMatchingActive(request);
    if (!active) {
      return actionResult(this.isStale(request) ? 'stale' : 'unavailable');
    }
    active.browserWindow.webContents.reload();
    return actionResult('accepted');
  };

  goBack = (request: PreviewSessionRequest): PreviewActionResult => {
    const active = this.getMatchingActive(request);
    if (
      !active ||
      !active.browserWindow.webContents.navigationHistory.canGoBack()
    ) {
      return actionResult(
        this.isStale(request) ? 'stale' : 'unavailable',
      );
    }
    active.browserWindow.webContents.navigationHistory.goBack();
    return actionResult('accepted');
  };

  goForward = (request: PreviewSessionRequest): PreviewActionResult => {
    const active = this.getMatchingActive(request);
    if (
      !active ||
      !active.browserWindow.webContents.navigationHistory.canGoForward()
    ) {
      return actionResult(
        this.isStale(request) ? 'stale' : 'unavailable',
      );
    }
    active.browserWindow.webContents.navigationHistory.goForward();
    return actionResult('accepted');
  };

  close = async (
    request: PreviewSessionRequest,
  ): Promise<PreviewActionResult> => {
    const active = this.getMatchingActive(request);
    if (!active) {
      return actionResult(this.isStale(request) ? 'stale' : 'unavailable');
    }
    await this.closeActive(true);
    return actionResult('accepted');
  };

  hideForApproval = (): void => {
    const active = this.active;
    if (!active || active.browserWindow.isDestroyed()) {
      return;
    }
    active.browserWindow.hide();
    this.publishReady(active, false);
  };

  closeForWorkspaceChange = async (): Promise<void> => {
    await this.closeActive(true);
  };

  shutdown = (): void => {
    void this.closeActive(true);
  };

  private installSessionPolicy = async (
    browserSession: Session,
    location: PreviewLocation,
  ): Promise<void> => {
    await browserSession.clearStorageData();
    await browserSession.setProxy({ mode: 'direct' });
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    browserSession.setDevicePermissionHandler(() => false);
    browserSession.on('will-download', (event) => event.preventDefault());
    browserSession.webRequest.onBeforeRequest(
      { urls: ['<all_urls>'] },
      (details, callback) => {
        callback({
          cancel: !isAllowedPreviewRequest(
            location,
            details.url,
            details.method,
            details.resourceType,
          ),
        });
      },
    );
    browserSession.webRequest.onHeadersReceived(
      { urls: ['<all_urls>'] },
      (details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [PREVIEW_CSP],
            'Permissions-Policy': [
              'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
            ],
            'X-DNS-Prefetch-Control': ['off'],
          },
        });
      },
    );
  };

  private installWindowPolicy = (active: ActivePreview): void => {
    const { browserWindow, location } = active;
    browserWindow.setMenu(null);
    browserWindow.webContents.setWindowOpenHandler(() => ({
      action: 'deny',
    }));
    browserWindow.webContents.on('page-title-updated', (event) => {
      event.preventDefault();
      browserWindow.setTitle(PREVIEW_TITLE);
    });
    browserWindow.webContents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
    const guardNavigation = (
      event: Electron.Event,
      targetUrl: string,
    ): void => {
      if (
        !isAllowedPreviewRequest(
          location,
          targetUrl,
          'GET',
          'mainFrame',
        )
      ) {
        event.preventDefault();
      }
    };
    browserWindow.webContents.on('will-navigate', guardNavigation);
    browserWindow.webContents.on('will-redirect', guardNavigation);
    const publishNavigation = (_event: Electron.Event, url: string): void => {
      if (this.active !== active) {
        return;
      }
      const next = parsePreviewLocation(url);
      if (!next || next.origin !== location.origin) {
        return;
      }
      active.location = next;
      this.publishReady(active, browserWindow.isVisible());
    };
    browserWindow.webContents.on('did-navigate', publishNavigation);
    browserWindow.webContents.on(
      'did-navigate-in-page',
      publishNavigation,
    );
    browserWindow.webContents.on(
      'did-fail-load',
      (_event, errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
        if (
          isMainFrame &&
          errorCode !== -3 &&
          this.active === active &&
          this.snapshot.status !== 'opening'
        ) {
          void this.failActive(active, 'loadFailed');
        }
      },
    );
    browserWindow.webContents.once('render-process-gone', () => {
      if (this.active === active) {
        void this.failActive(active, 'renderProcessGone');
      }
    });
    browserWindow.once('closed', () => {
      if (this.active !== active) {
        return;
      }
      this.active = null;
      void this.clearSession(active.browserSession);
      this.publish({ status: 'closed' });
    });
  };

  private getMatchingActive = (
    request: PreviewSessionRequest,
  ): ActivePreview | null => {
    const active = this.active;
    return active &&
      active.generation === request.generation &&
      active.sessionId === request.sessionId &&
      !active.browserWindow.isDestroyed()
      ? active
      : null;
  };

  private isStale = (request: PreviewSessionRequest): boolean =>
    request.generation !== this.options.getWorkspaceState().generation ||
    (this.active !== null &&
      request.sessionId !== this.active.sessionId);

  private publishReady = (
    active: ActivePreview,
    visible: boolean,
  ): void => {
    if (this.active !== active || active.browserWindow.isDestroyed()) {
      return;
    }
    this.publish({
      status: 'ready',
      generation: active.generation,
      sessionId: active.sessionId,
      url: active.location.url,
      origin: active.location.origin,
      visible,
      canGoBack:
        active.browserWindow.webContents.navigationHistory.canGoBack(),
      canGoForward:
        active.browserWindow.webContents.navigationHistory.canGoForward(),
    });
  };

  private failActive = async (
    active: ActivePreview,
    error: PreviewFailure,
  ): Promise<void> => {
    if (this.active !== active) {
      return;
    }
    this.active = null;
    active.browserWindow.webContents.stop();
    if (!active.browserWindow.isDestroyed()) {
      active.browserWindow.destroy();
    }
    await this.clearSession(active.browserSession);
    this.publishFailure(active.generation, active.location, error);
  };

  private closeActive = async (publishClosed: boolean): Promise<void> => {
    const active = this.active;
    if (!active) {
      if (publishClosed && this.snapshot.status !== 'closed') {
        this.publish({ status: 'closed' });
      }
      return;
    }
    this.active = null;
    active.browserWindow.webContents.stop();
    if (!active.browserWindow.isDestroyed()) {
      active.browserWindow.destroy();
    }
    await this.clearSession(active.browserSession);
    if (publishClosed) {
      this.publish({ status: 'closed' });
    }
  };

  private clearSession = async (browserSession: Session): Promise<void> => {
    browserSession.setPermissionCheckHandler(null);
    browserSession.setPermissionRequestHandler(null);
    browserSession.setDevicePermissionHandler(null);
    browserSession.webRequest.onBeforeRequest(null);
    browserSession.webRequest.onHeadersReceived(null);
    await browserSession.clearStorageData().catch((): undefined => undefined);
    await browserSession.closeAllConnections().catch(
      (): undefined => undefined,
    );
  };

  private publishFailure = (
    generation: number,
    location: PreviewLocation,
    error: PreviewFailure,
  ): void => {
    this.publish({
      status: 'failed',
      generation,
      url: location.url,
      origin: location.origin,
      error,
    });
  };

  private publish = (
    snapshot: PreviewStateWithoutRevision,
  ): void => {
    this.revision += 1;
    this.snapshot = {
      revision: this.revision,
      ...snapshot,
    } as PreviewStateSnapshot;
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  };
}
