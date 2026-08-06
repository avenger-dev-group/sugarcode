import { app, BrowserWindow, dialog } from 'electron';
import started from 'electron-squirrel-startup';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { registerCommandApprovalIpc } from '@/main/app-server/command-approval/ipc';
import { registerConnectionIpc } from '@/main/app-server/connection/ipc';
import { ConnectionSupervisor } from '@/main/app-server/connection/supervisor';
import { registerConversationIpc } from '@/main/app-server/conversation/ipc';
import { GitController } from '@/main/app-server/git/controller';
import { registerGitIpc } from '@/main/app-server/git/ipc';
import { registerMcpIpc } from '@/main/app-server/mcp/ipc';
import { McpSessionController } from '@/main/app-server/mcp/session-controller';
import { registerModelConfigIpc } from '@/main/app-server/model-config/ipc';
import { ThreadRegistry } from '@/main/app-server/thread-registry';
import { WorkspaceController } from '@/main/app-server/workspace/controller';
import { registerWorkspaceIpc } from '@/main/app-server/workspace/ipc';
import { PreviewController } from '@/main/preview/controller';
import { registerPreviewIpc } from '@/main/preview/ipc';
import { TerminalController } from '@/main/terminal/controller';
import { registerTerminalIpc } from '@/main/terminal/ipc';
import { RuntimeSupervisor } from '@/main/runtime/supervisor';
import { RuntimeModelConfigController } from '@/main/runtime/model-config-controller';
import { RuntimeConversationController } from '@/main/runtime/conversation-controller';
import { RuntimeApprovalController } from '@/main/runtime/approval-controller';
import { RuntimeGitAdapter } from '@/main/runtime/git-adapter';
import { RuntimeMcpConfigController } from '@/main/runtime/mcp-config-controller';
import { RuntimeMcpApprovalController } from '@/main/runtime/mcp-approval-controller';

let mainWindow: BrowserWindow | null = null;
let supervisor: ConnectionSupervisor | null = null;
let disposeConnectionIpc: (() => void) | null = null;
let disposeCommandApprovalIpc: (() => void) | null = null;
let disposeConversationIpc: (() => void) | null = null;
let disposeMcpIpc: (() => void) | null = null;
let disposeModelConfigIpc: (() => void) | null = null;
let disposeWorkspaceIpc: (() => void) | null = null;
let disposeGitIpc: (() => void) | null = null;
let previewController: PreviewController | null = null;
let disposePreviewIpc: (() => void) | null = null;
let disposePreviewApprovalSubscriptions: (() => void) | null = null;
let terminalController: TerminalController | null = null;
let disposeTerminalIpc: (() => void) | null = null;
let runtimeSupervisor: RuntimeSupervisor | null = null;
let runtimeConversationController: RuntimeConversationController | null = null;
let runtimeApprovalController: RuntimeApprovalController | null = null;
let runtimeGitAdapter: RuntimeGitAdapter | null = null;
let runtimeMcpSessionController: McpSessionController | null = null;
let runtimeMcpApprovalController: RuntimeMcpApprovalController | null = null;
let disposeRuntimeEvents: (() => void) | null = null;
let disposeRuntimeWorkspaceEvents: (() => void) | null = null;

const rendererFilePath = path.join(
  __dirname,
  `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
);
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(app.getAppPath(), 'assets', 'icon.png');

const isAllowedRendererUrl = (url: string): boolean => {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    try {
      return (
        new URL(url).origin ===
        new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
      );
    } catch {
      return false;
    }
  }
  return url === pathToFileURL(rendererFilePath).toString();
};

const createWindow = (): void => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    icon: appIconPath,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 12 } }
      : {
          titleBarOverlay: {
            color: '#00000000',
            symbolColor: '#808080',
            height: 36,
          },
        }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererUrl(url)) {
      event.preventDefault();
    }
  });
  window.webContents.on(
    'did-start-navigation',
    (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) {
        supervisor?.approvalSurfacesUnavailable();
        runtimeApprovalController?.surfaceUnavailable();
        previewController?.shutdown();
        terminalController?.rendererUnavailable();
      }
    },
  );
  window.webContents.on('render-process-gone', () => {
    supervisor?.approvalSurfacesUnavailable();
    runtimeApprovalController?.surfaceUnavailable();
    runtimeMcpApprovalController?.surfaceUnavailable();
    previewController?.shutdown();
    terminalController?.rendererUnavailable();
  });
  window.once('closed', () => {
    supervisor?.approvalSurfacesUnavailable();
    runtimeApprovalController?.surfaceUnavailable();
    previewController?.shutdown();
    terminalController?.rendererUnavailable();
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    window.webContents.openDevTools();
  } else {
    void window.loadFile(rendererFilePath);
  }
};

const startApplication = async (): Promise<void> => {
  await app.whenReady();
  runtimeSupervisor = new RuntimeSupervisor({
    runtimePath: path.join(__dirname, 'runtime.mjs'),
    dataDirectory: path.join(app.getPath('home'), '.sugarcode', 'v3'),
    nativeModulePath: app.isPackaged
      ? path.join(process.resourcesPath, 'sugarcode-desktop-native.node')
      : path.join(app.getAppPath(), 'native', 'sugarcode-desktop-native.node'),
  });
  disposeRuntimeEvents = runtimeSupervisor.subscribe((event) => {
    if (event.type === 'runtime.log') {
      const log = event.level === 'debug' ? console.debug : console[event.level];
      log(`[runtime] ${event.message}`);
    } else if (event.type === 'runtime.ready') {
      console.info(`[runtime] protocol ${event.protocolVersion} ready`);
    }
  });
  runtimeSupervisor.start();
  runtimeConversationController = new RuntimeConversationController(
    runtimeSupervisor,
  );
  runtimeApprovalController = new RuntimeApprovalController(runtimeSupervisor);
  runtimeMcpApprovalController = new RuntimeMcpApprovalController(runtimeSupervisor);
  runtimeMcpSessionController = new McpSessionController({
    getRestartBlock: () => {
      const phase = runtimeConversationController?.getSnapshot().phase;
      if (phase === 'starting' || phase === 'inProgress' || phase === 'stopping') {
        return 'turnActive';
      }
      if (
        runtimeApprovalController?.getSnapshot().status === 'pending' ||
        runtimeMcpApprovalController?.getSnapshot().status === 'pending'
      ) {
        return 'approvalPending';
      }
      return null;
    },
    restart: async (serverIds) => {
      try {
        const event = await runtimeSupervisor?.request(
          { type: 'mcp.sessionSet', requestId: randomUUID(), serverIds },
          'mcp.sessionAction',
          45_000,
        );
        return event?.action.accepted === true;
      } catch {
        return false;
      }
    },
  });
  const runtimeMcpConfigController = new RuntimeMcpConfigController(
    runtimeSupervisor,
    (inspection) => {
      runtimeMcpSessionController?.initialize(
        inspection.servers.map(({ id, transport }) => ({ id, transport })),
      );
    },
  );
  void runtimeMcpConfigController.inspect().catch(() => {
    runtimeMcpSessionController?.unavailable(
      'MCP configuration could not be loaded from local storage.',
    );
  });
  runtimeGitAdapter = new RuntimeGitAdapter(runtimeSupervisor);
  const threadRegistry = new ThreadRegistry();
  supervisor = new ConnectionSupervisor({
    threadRegistry,
    desktopAppPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    clientVersion: app.getVersion(),
  });
  const workspaceController = new WorkspaceController({
    threadRegistry,
    supervisor,
    dialog,
    getMainWindow: () => mainWindow,
    sessionPath: path.join(app.getPath('userData'), 'workspace-session-v1.json'),
    chatRootPath: path.join(app.getPath('documents'), 'SugarCode'),
    beforeWorkspaceSwitch: async () => {
      await terminalController?.closeForWorkspaceChange();
      await previewController?.closeForWorkspaceChange();
    },
  });
  await workspaceController.restore();
  let runtimeWorkspaceGeneration = -1;
  let activeRuntimeWorkspaceId: string | null = null;
  disposeRuntimeWorkspaceEvents = workspaceController.subscribe((snapshot) => {
    if (snapshot.status !== 'ready') {
      activeRuntimeWorkspaceId = null;
      return;
    }
    if (
      snapshot.generation === runtimeWorkspaceGeneration &&
      activeRuntimeWorkspaceId !== null
    ) {
      return;
    }
    const workspace = workspaceController.getLaunchContext();
    if (!workspace) {
      return;
    }
    runtimeWorkspaceGeneration = snapshot.generation;
    const runtimeWorkspaceId = createHash('sha256')
      .update(workspace.path)
      .digest('hex');
    activeRuntimeWorkspaceId = runtimeWorkspaceId;
    runtimeSupervisor?.send({
      type: 'workspace.open',
      requestId: randomUUID(),
      workspaceId: runtimeWorkspaceId,
      canonicalRoot: workspace.path,
    });
    runtimeApprovalController?.openWorkspace(
      runtimeWorkspaceId,
      workspace.path,
    );
    runtimeMcpApprovalController?.openWorkspace(
      runtimeWorkspaceId,
      workspace.path,
    );
    runtimeGitAdapter?.openWorkspace(runtimeWorkspaceId);
    void runtimeConversationController?.switchWorkspace(
      runtimeWorkspaceId,
    );
  });
  terminalController = new TerminalController({
    dialog,
    runtime: runtimeSupervisor,
    getMainWindow: () => mainWindow,
    getWorkspace: workspaceController.getLaunchContext,
    getRuntimeWorkspaceId: () => activeRuntimeWorkspaceId,
    isApprovalPending: () =>
      runtimeApprovalController?.getSnapshot().status === 'pending' ||
      runtimeMcpApprovalController?.getSnapshot().status === 'pending',
  });
  previewController = new PreviewController({
    dialog,
    getMainWindow: () => mainWindow,
    getWorkspaceState: workspaceController.getSnapshot,
    isApprovalPending: () =>
      runtimeApprovalController?.getSnapshot().status === 'pending' ||
      runtimeMcpApprovalController?.getSnapshot().status === 'pending',
  });
  disposeConnectionIpc = registerConnectionIpc({
    supervisor,
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeCommandApprovalIpc = registerCommandApprovalIpc({
    controller: runtimeApprovalController,
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeConversationIpc = registerConversationIpc({
    controller: runtimeConversationController,
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeMcpIpc = registerMcpIpc({
    session: runtimeMcpSessionController,
    approvals: runtimeMcpApprovalController,
    config: runtimeMcpConfigController,
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeModelConfigIpc = registerModelConfigIpc({
    controller: new RuntimeModelConfigController(runtimeSupervisor),
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeWorkspaceIpc = registerWorkspaceIpc({
    controller: workspaceController,
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeGitIpc = registerGitIpc({
    controller: new GitController({
      supervisor: runtimeGitAdapter,
      workspace: workspaceController,
    }),
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposePreviewIpc = registerPreviewIpc({
    controller: previewController,
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeTerminalIpc = registerTerminalIpc({
    controller: terminalController,
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  const hidePreviewForApproval = (): void => {
    const approvalPending =
      runtimeApprovalController?.getSnapshot().status === 'pending' ||
      runtimeMcpApprovalController?.getSnapshot().status === 'pending';
    if (!approvalPending) {
      terminalController?.resumeAfterApproval();
      return;
    }
    terminalController?.pauseForApproval();
    previewController?.hideForApproval();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  };
  const unsubscribeCommandApproval =
    runtimeApprovalController.subscribe(hidePreviewForApproval);
  const unsubscribeMcpApproval =
    runtimeMcpApprovalController.subscribe(hidePreviewForApproval);
  disposePreviewApprovalSubscriptions = () => {
    unsubscribeCommandApproval();
    unsubscribeMcpApproval();
  };
  createWindow();
  void supervisor.start();
};

if (started) {
  app.quit();
} else {
  void startApplication();

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('before-quit', () => {
    runtimeSupervisor?.shutdown();
    terminalController?.shutdown();
    previewController?.shutdown();
    supervisor?.shutdown();
  });

  app.on('will-quit', () => {
    runtimeSupervisor?.shutdown();
    runtimeSupervisor = null;
    runtimeConversationController = null;
    runtimeApprovalController = null;
    runtimeGitAdapter = null;
    disposeRuntimeEvents?.();
    disposeRuntimeEvents = null;
    disposeRuntimeWorkspaceEvents?.();
    disposeRuntimeWorkspaceEvents = null;
    supervisor?.shutdown();
    disposeConnectionIpc?.();
    disposeConnectionIpc = null;
    disposeCommandApprovalIpc?.();
    disposeCommandApprovalIpc = null;
    disposeConversationIpc?.();
    disposeConversationIpc = null;
    disposeMcpIpc?.();
    disposeMcpIpc = null;
    disposeModelConfigIpc?.();
    disposeModelConfigIpc = null;
    disposeWorkspaceIpc?.();
    disposeWorkspaceIpc = null;
    disposeGitIpc?.();
    disposeGitIpc = null;
    disposePreviewIpc?.();
    disposePreviewIpc = null;
    disposeTerminalIpc?.();
    disposeTerminalIpc = null;
    disposePreviewApprovalSubscriptions?.();
    disposePreviewApprovalSubscriptions = null;
    previewController?.shutdown();
    previewController = null;
    terminalController?.shutdown();
    terminalController = null;
  });
}
