import {
  BrowserWindow,
  session,
  type Dialog,
  type Session,
  WebContentsView,
} from 'electron';
import { randomUUID } from 'node:crypto';

import type {
  PreviewActionReason,
  PreviewActionResult,
  PreviewBounds,
  PreviewBoundsRequest,
  PreviewFailure,
  PreviewNavigateRequest,
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

type DialogBoundary = Pick<Dialog, 'showMessageBox'>;

type PreviewControllerOptions = Readonly<{
  dialog: DialogBoundary;
  getMainWindow: () => BrowserWindow | null;
  getWorkspaceState: () => WorkspaceStateSnapshot;
  isApprovalPending: () => boolean;
  openExternal: (url: string) => Promise<void>;
  createWebContentsView?: (
    options: Electron.WebContentsViewConstructorOptions,
  ) => WebContentsView;
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
  mainWindow: BrowserWindow;
  browserView: WebContentsView;
  browserSession: Session;
  bounds: PreviewBounds | null;
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
  private readonly createWebContentsView: NonNullable<
    PreviewControllerOptions['createWebContentsView']
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
    this.createWebContentsView =
      options.createWebContentsView ??
      ((viewOptions) => new WebContentsView(viewOptions));
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
          buttons: ['取消', '打开本地应用'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: '在预览浏览器中打开？',
          message: `打开 ${location.origin}？`,
          detail:
            '该本地应用的脚本和同源请求将可以运行，以便测试真实交互。SugarCode 会使用隔离会话，并阻止跳转到其他主机或端口、下载、弹窗和系统权限。请只打开你信任的开发服务。',
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
      let browserView: WebContentsView;
      try {
        browserView = this.createWebContentsView({
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            devTools: true,
            webviewTag: false,
            javascript: true,
            disableDialogs: true,
            navigateOnDragDrop: false,
            partition,
            spellcheck: false,
          },
        });
        browserView.setBackgroundColor('#ffffff');
        browserView.setVisible(false);
        mainWindow.contentView.addChildView(browserView);
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
        mainWindow,
        browserView,
        browserSession,
        bounds: null,
      };
      this.active = active;
      try {
        this.installViewPolicy(active);
      } catch {
        await this.failActive(active, 'policyUnavailable');
        return actionResult('failed');
      }

      try {
        await withTimeout(
          browserView.webContents.loadURL(location.url),
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
      if (active.bounds) {
        browserView.setVisible(true);
      }
      this.publishReady(active, active.bounds !== null);
      return actionResult('accepted');
    } finally {
      this.operationActive = false;
    }
  };

  openExternal = async (
    request: PreviewOpenRequest,
  ): Promise<PreviewActionResult> => {
    if (this.operationActive) {
      return actionResult('busy');
    }
    const location = parsePreviewLocation(request.url);
    if (!location) {
      return actionResult('invalid');
    }
    const workspace = this.options.getWorkspaceState();
    if (request.generation !== workspace.generation) {
      return actionResult('stale');
    }
    if (workspace.status !== 'ready') {
      return actionResult('unavailable');
    }
    if (this.options.isApprovalPending()) {
      return actionResult('busy');
    }
    this.operationActive = true;
    try {
      await this.options.openExternal(location.url);
      return actionResult('accepted');
    } catch {
      return actionResult('failed');
    } finally {
      this.operationActive = false;
    }
  };

  setBounds = (request: PreviewBoundsRequest): PreviewActionResult => {
    const active = this.getMatchingActive(request);
    if (!active) {
      return actionResult(this.isStale(request) ? 'stale' : 'unavailable');
    }
    if (this.options.isApprovalPending()) {
      return actionResult('busy');
    }
    const unchanged = request.bounds === null
      ? active.bounds === null
      : active.bounds !== null &&
        active.bounds.x === request.bounds.x &&
        active.bounds.y === request.bounds.y &&
        active.bounds.width === request.bounds.width &&
        active.bounds.height === request.bounds.height;
    if (unchanged) {
      return actionResult('accepted');
    }
    active.bounds = request.bounds;
    if (request.bounds) {
      active.browserView.setBounds(request.bounds);
    }
    const visible = request.bounds !== null && this.snapshot.status === 'ready';
    active.browserView.setVisible(visible);
    if (this.snapshot.status === 'ready') {
      this.publishReady(active, visible);
    }
    return actionResult('accepted');
  };

  navigate = async (
    request: PreviewNavigateRequest,
  ): Promise<PreviewActionResult> => {
    const active = this.getMatchingActive(request);
    if (!active) {
      return actionResult(this.isStale(request) ? 'stale' : 'unavailable');
    }
    const location = parsePreviewLocation(request.url);
    if (!location || location.origin !== active.location.origin) {
      return actionResult('invalid');
    }
    try {
      await withTimeout(
        active.browserView.webContents.loadURL(location.url),
        this.loadTimeoutMs,
      );
      return actionResult('accepted');
    } catch {
      if (this.active === active) {
        await this.failActive(active, 'loadFailed');
      }
      return actionResult('failed');
    }
  };

  reload = (request: PreviewSessionRequest): PreviewActionResult => {
    const active = this.getMatchingActive(request);
    if (!active) {
      return actionResult(this.isStale(request) ? 'stale' : 'unavailable');
    }
    active.browserView.webContents.reload();
    return actionResult('accepted');
  };

  goBack = (request: PreviewSessionRequest): PreviewActionResult => {
    const active = this.getMatchingActive(request);
    if (
      !active ||
      !active.browserView.webContents.navigationHistory.canGoBack()
    ) {
      return actionResult(
        this.isStale(request) ? 'stale' : 'unavailable',
      );
    }
    active.browserView.webContents.navigationHistory.goBack();
    return actionResult('accepted');
  };

  goForward = (request: PreviewSessionRequest): PreviewActionResult => {
    const active = this.getMatchingActive(request);
    if (
      !active ||
      !active.browserView.webContents.navigationHistory.canGoForward()
    ) {
      return actionResult(
        this.isStale(request) ? 'stale' : 'unavailable',
      );
    }
    active.browserView.webContents.navigationHistory.goForward();
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
    if (!active || active.browserView.webContents.isDestroyed()) {
      return;
    }
    active.browserView.setVisible(false);
    if (this.snapshot.status === 'ready') {
      this.publishReady(active, false);
    }
  };

  resumeAfterApproval = (): void => {
    const active = this.active;
    if (
      !active ||
      active.browserView.webContents.isDestroyed() ||
      this.snapshot.status !== 'ready'
    ) {
      return;
    }
    const visible = active.bounds !== null;
    active.browserView.setVisible(visible);
    this.publishReady(active, visible);
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
            'Permissions-Policy': [
              'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
            ],
            'X-DNS-Prefetch-Control': ['off'],
          },
        });
      },
    );
  };

  private installViewPolicy = (active: ActivePreview): void => {
    const { browserView, location } = active;
    browserView.webContents.setWindowOpenHandler(() => ({
      action: 'deny',
    }));
    browserView.webContents.on('will-attach-webview', (event) => {
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
    browserView.webContents.on('will-navigate', guardNavigation);
    browserView.webContents.on('will-redirect', guardNavigation);
    const publishNavigation = (_event: Electron.Event, url: string): void => {
      if (this.active !== active) {
        return;
      }
      const next = parsePreviewLocation(url);
      if (!next || next.origin !== location.origin) {
        return;
      }
      active.location = next;
      this.publishReady(active, browserView.getVisible());
    };
    browserView.webContents.on('did-navigate', publishNavigation);
    browserView.webContents.on(
      'did-navigate-in-page',
      publishNavigation,
    );
    browserView.webContents.on(
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
    browserView.webContents.once('render-process-gone', () => {
      if (this.active === active) {
        void this.failActive(active, 'renderProcessGone');
      }
    });
    browserView.webContents.once('destroyed', () => {
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
      !active.browserView.webContents.isDestroyed()
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
    if (this.active !== active || active.browserView.webContents.isDestroyed()) {
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
        active.browserView.webContents.navigationHistory.canGoBack(),
      canGoForward:
        active.browserView.webContents.navigationHistory.canGoForward(),
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
    active.browserView.webContents.stop();
    if (!active.mainWindow.isDestroyed()) {
      active.mainWindow.contentView.removeChildView(active.browserView);
    }
    if (!active.browserView.webContents.isDestroyed()) {
      active.browserView.webContents.close();
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
    active.browserView.webContents.stop();
    if (!active.mainWindow.isDestroyed()) {
      active.mainWindow.contentView.removeChildView(active.browserView);
    }
    if (!active.browserView.webContents.isDestroyed()) {
      active.browserView.webContents.close();
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
