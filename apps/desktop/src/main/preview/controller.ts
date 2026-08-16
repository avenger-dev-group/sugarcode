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
  PreviewArtifactOpenRequest,
  PreviewArtifactRequest,
  PreviewBounds,
  PreviewBoundsRequest,
  PreviewFailure,
  PreviewExternalOpenRequest,
  PreviewNavigateRequest,
  PreviewOpenRequest,
  PreviewSessionRequest,
  PreviewStateSnapshot,
  PreviewTabState,
} from '@/shared/preview';
import type { WorkspaceStateSnapshot } from '@/shared/workspace';

import { resolvePreviewArtifact } from './artifact-file';
import {
  createArtifactPreviewLocation,
  isAllowedPreviewRequest,
  isLoopbackPreviewLocation,
  parsePreviewLocation,
  type PreviewLocation,
} from './url';

const INITIAL_LOAD_TIMEOUT_MS = 15_000;

type DialogBoundary = Pick<Dialog, 'showMessageBox'>;

type PreviewControllerOptions = Readonly<{
  dialog: DialogBoundary;
  getMainWindow: () => BrowserWindow | null;
  getWorkspaceState: () => WorkspaceStateSnapshot;
  getWorkspace: () => import('../workspace/controller').WorkspaceLaunchContext | null;
  isApprovalPending: () => boolean;
  openExternal: (url: string) => Promise<void>;
  openPath: (path: string) => Promise<void>;
  showItemInFolder: (path: string) => void;
  createWebContentsView?: (
    options: Electron.WebContentsViewConstructorOptions,
  ) => WebContentsView;
  getSession?: (partition: string) => Session;
  createSessionId?: () => string;
  loadTimeoutMs?: number;
}>;

type Listener = (snapshot: PreviewStateSnapshot) => void;

type ActivePreview = {
  previewId: string;
  generation: number;
  sessionId: string;
  policyLocation: PreviewLocation;
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
  private readonly actives = new Map<string, ActivePreview>();
  private readonly tabStates = new Map<string, PreviewTabState>();
  private snapshot: PreviewStateSnapshot = {
    revision: 0,
    tabs: [],
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
    const location = parsePreviewLocation(request.url);
    if (!location) {
      return actionResult('invalid');
    }
    return this.openLocation(
      request,
      location,
      isLoopbackPreviewLocation(location),
    );
  };

  openArtifact = async (
    request: PreviewArtifactOpenRequest,
  ): Promise<PreviewActionResult> => {
    const workspace = this.options.getWorkspace();
    if (
      !workspace ||
      workspace.generation !== request.generation ||
      this.options.getWorkspaceState().status !== 'ready'
    ) {
      return actionResult('stale');
    }
    const artifact = await resolvePreviewArtifact(workspace, request.path);
    return artifact
      ? this.openLocation(
          request,
          createArtifactPreviewLocation(artifact.url, artifact.root),
          false,
        )
      : actionResult('invalid');
  };

  private openLocation = async (
    request: Pick<PreviewOpenRequest, 'previewId' | 'generation'>,
    location: PreviewLocation,
    confirmLocalService: boolean,
  ): Promise<PreviewActionResult> => {
    if (this.operationActive) {
      return actionResult('busy');
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
      if (confirmLocalService) {
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
              '该本地应用的脚本和网络请求将可以运行，以便测试真实交互。SugarCode 会使用隔离会话，并阻止下载、弹窗、系统权限和本地文件访问。请只打开你信任的开发服务。',
          },
        );
        if (confirmation.response !== 1) {
          return actionResult('cancelled');
        }
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

      await this.closePreviewId(request.previewId, false);
      const sessionId = this.createSessionId();
      const partition = `preview-${sessionId}`;
      let browserSession: Session;
      try {
        browserSession = this.getSession(partition);
      } catch {
        this.publishFailure(
          request.previewId,
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
          request.previewId,
          request.generation,
          location,
          'policyUnavailable',
        );
        return actionResult('failed');
      }

      this.publishTab({
        previewId: request.previewId,
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
            backgroundThrottling: true,
          },
        });
        browserView.setBackgroundColor('#ffffff');
        browserView.setVisible(false);
        browserView.webContents.setAudioMuted(true);
        mainWindow.contentView.addChildView(browserView);
      } catch {
        await this.clearSession(browserSession);
        this.publishFailure(
          request.previewId,
          request.generation,
          location,
          'policyUnavailable',
        );
        return actionResult('failed');
      }
      const active: ActivePreview = {
        previewId: request.previewId,
        generation: request.generation,
        sessionId,
        policyLocation: location,
        location,
        mainWindow,
        browserView,
        browserSession,
        bounds: null,
      };
      this.actives.set(active.previewId, active);
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
        if (this.isCurrentActive(active)) {
          await this.failActive(active, 'loadFailed');
        }
        return actionResult('failed');
      }
      if (
        !this.isCurrentActive(active) ||
        this.options.getWorkspaceState().generation !== request.generation ||
        this.options.getWorkspaceState().status !== 'ready'
      ) {
        await this.closePreviewId(active.previewId, true);
        return actionResult('stale');
      }
      if (active.bounds) {
        this.setPreviewVisibility(active, true);
      }
      this.publishReady(active, active.bounds !== null);
      return actionResult('accepted');
    } finally {
      this.operationActive = false;
    }
  };

  openExternal = async (
    request: PreviewExternalOpenRequest,
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

  openExternalArtifact = async (
    request: PreviewArtifactRequest,
  ): Promise<PreviewActionResult> => {
    if (this.operationActive) {
      return actionResult('busy');
    }
    const workspace = this.options.getWorkspace();
    if (
      !workspace ||
      workspace.generation !== request.generation ||
      this.options.getWorkspaceState().status !== 'ready'
    ) {
      return actionResult('stale');
    }
    if (this.options.isApprovalPending()) {
      return actionResult('busy');
    }
    const artifact = await resolvePreviewArtifact(workspace, request.path);
    if (!artifact) {
      return actionResult('invalid');
    }
    this.operationActive = true;
    try {
      await this.options.openPath(artifact.absolutePath);
      return actionResult('accepted');
    } catch {
      return actionResult('failed');
    } finally {
      this.operationActive = false;
    }
  };

  revealArtifact = async (
    request: PreviewArtifactRequest,
  ): Promise<PreviewActionResult> => {
    const workspace = this.options.getWorkspace();
    if (!workspace || workspace.generation !== request.generation) {
      return actionResult('stale');
    }
    const artifact = await resolvePreviewArtifact(workspace, request.path);
    if (!artifact) {
      return actionResult('invalid');
    }
    try {
      this.options.showItemInFolder(artifact.absolutePath);
      return actionResult('accepted');
    } catch {
      return actionResult('failed');
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
    const ready = this.tabStates.get(active.previewId)?.status === 'ready';
    const visible = request.bounds !== null && ready;
    this.setPreviewVisibility(active, visible);
    if (ready) {
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
    const webLocation = parsePreviewLocation(request.url);
    const location = webLocation ?? (
      active.policyLocation.kind === 'artifact' &&
      isAllowedPreviewRequest(
        active.policyLocation,
        request.url,
        'GET',
        'mainFrame',
      )
        ? createArtifactPreviewLocation(
            request.url,
            active.policyLocation.root,
          )
        : null
    );
    if (!location) {
      return actionResult('invalid');
    }
    try {
      await withTimeout(
        active.browserView.webContents.loadURL(location.url),
        this.loadTimeoutMs,
      );
      return actionResult('accepted');
    } catch {
      if (this.isCurrentActive(active)) {
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
    await this.closePreviewId(active.previewId, true);
    return actionResult('accepted');
  };

  hideForApproval = (): void => {
    for (const active of this.actives.values()) {
      if (active.browserView.webContents.isDestroyed()) {
        continue;
      }
      this.setPreviewVisibility(active, false);
      if (this.tabStates.get(active.previewId)?.status === 'ready') {
        this.publishReady(active, false);
      }
    }
  };

  resumeAfterApproval = (): void => {
    for (const active of this.actives.values()) {
      if (
        active.browserView.webContents.isDestroyed() ||
        this.tabStates.get(active.previewId)?.status !== 'ready'
      ) {
        continue;
      }
      const visible = active.bounds !== null;
      this.setPreviewVisibility(active, visible);
      this.publishReady(active, visible);
    }
  };

  closeForWorkspaceChange = async (): Promise<void> => {
    await this.closeAll(true);
  };

  shutdown = (): void => {
    void this.closeAll(true);
  };

  private installSessionPolicy = async (
    browserSession: Session,
    location: PreviewLocation,
  ): Promise<void> => {
    await browserSession.clearStorageData();
    await browserSession.setProxy({
      mode: location.kind === 'web' && isLoopbackPreviewLocation(location)
        ? 'direct'
        : 'system',
    });
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
    const { browserView, policyLocation } = active;
    browserView.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedPreviewRequest(policyLocation, url, 'GET', 'mainFrame')) {
        void browserView.webContents.loadURL(url);
      }
      return { action: 'deny' };
    });
    browserView.webContents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
    const guardNavigation = (
      event: Electron.Event,
      targetUrl: string,
    ): void => {
      if (
        !isAllowedPreviewRequest(
          policyLocation,
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
      if (!this.isCurrentActive(active)) {
        return;
      }
      const webLocation = parsePreviewLocation(url);
      if (webLocation) {
        active.location = webLocation;
        this.publishReady(active, browserView.getVisible());
        return;
      }
      if (
        policyLocation.kind !== 'artifact' ||
        !isAllowedPreviewRequest(policyLocation, url, 'GET', 'mainFrame')
      ) {
        return;
      }
      active.location = createArtifactPreviewLocation(
        url,
        policyLocation.root,
      );
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
          this.isCurrentActive(active) &&
          this.tabStates.get(active.previewId)?.status !== 'opening'
        ) {
          void this.failActive(active, 'loadFailed');
        }
      },
    );
    browserView.webContents.once('render-process-gone', () => {
      if (this.isCurrentActive(active)) {
        void this.failActive(active, 'renderProcessGone');
      }
    });
    browserView.webContents.once('destroyed', () => {
      if (!this.isCurrentActive(active)) {
        return;
      }
      this.actives.delete(active.previewId);
      void this.clearSession(active.browserSession);
      this.removeTabState(active.previewId);
    });
  };

  private getMatchingActive = (
    request: PreviewSessionRequest,
  ): ActivePreview | null => {
    const active = [...this.actives.values()].find(
      (candidate) => candidate.sessionId === request.sessionId,
    );
    return active &&
      active.generation === request.generation &&
      active.sessionId === request.sessionId &&
      !active.browserView.webContents.isDestroyed()
      ? active
      : null;
  };

  private isStale = (request: PreviewSessionRequest): boolean =>
    request.generation !== this.options.getWorkspaceState().generation ||
    ![...this.actives.values()].some(
      (active) => active.sessionId === request.sessionId,
    );

  private isCurrentActive = (active: ActivePreview): boolean =>
    this.actives.get(active.previewId) === active;

  private setPreviewVisibility = (
    active: ActivePreview,
    visible: boolean,
  ): void => {
    if (active.browserView.webContents.isDestroyed()) {
      return;
    }
    active.browserView.setVisible(visible);
    active.browserView.webContents.setAudioMuted(!visible);
  };

  private publishReady = (
    active: ActivePreview,
    visible: boolean,
  ): void => {
    if (!this.isCurrentActive(active) || active.browserView.webContents.isDestroyed()) {
      return;
    }
    this.publishTab({
      previewId: active.previewId,
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
    if (!this.isCurrentActive(active)) {
      return;
    }
    this.actives.delete(active.previewId);
    active.browserView.webContents.stop();
    if (!active.mainWindow.isDestroyed()) {
      active.mainWindow.contentView.removeChildView(active.browserView);
    }
    if (!active.browserView.webContents.isDestroyed()) {
      active.browserView.webContents.close();
    }
    await this.clearSession(active.browserSession);
    this.publishFailure(
      active.previewId,
      active.generation,
      active.location,
      error,
    );
  };

  private closePreviewId = async (
    previewId: string,
    publishClosed: boolean,
  ): Promise<void> => {
    const active = this.actives.get(previewId);
    if (!active) {
      if (publishClosed) {
        this.removeTabState(previewId);
      }
      return;
    }
    this.actives.delete(previewId);
    active.browserView.webContents.stop();
    if (!active.mainWindow.isDestroyed()) {
      active.mainWindow.contentView.removeChildView(active.browserView);
    }
    if (!active.browserView.webContents.isDestroyed()) {
      active.browserView.webContents.close();
    }
    await this.clearSession(active.browserSession);
    if (publishClosed) {
      this.removeTabState(previewId);
    }
  };

  private closeAll = async (publishClosed: boolean): Promise<void> => {
    await Promise.all(
      [...this.actives.keys()].map((previewId) =>
        this.closePreviewId(previewId, publishClosed),
      ),
    );
    if (publishClosed && this.tabStates.size > 0) {
      this.tabStates.clear();
      this.publishSnapshot();
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
    previewId: string,
    generation: number,
    location: PreviewLocation,
    error: PreviewFailure,
  ): void => {
    this.publishTab({
      previewId,
      status: 'failed',
      generation,
      url: location.url,
      origin: location.origin,
      error,
    });
  };

  private publishTab = (tab: PreviewTabState): void => {
    this.tabStates.set(tab.previewId, tab);
    this.publishSnapshot();
  };

  private removeTabState = (previewId: string): void => {
    if (!this.tabStates.delete(previewId)) {
      return;
    }
    this.publishSnapshot();
  };

  private publishSnapshot = (): void => {
    this.revision += 1;
    this.snapshot = {
      revision: this.revision,
      tabs: [...this.tabStates.values()],
    };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  };
}
