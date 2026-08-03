import { app, BrowserWindow, dialog } from 'electron';
import started from 'electron-squirrel-startup';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { registerCommandApprovalIpc } from '@/main/app-server/command-approval/ipc';
import { registerConnectionIpc } from '@/main/app-server/connection/ipc';
import { ConnectionSupervisor } from '@/main/app-server/connection/supervisor';
import { registerConversationIpc } from '@/main/app-server/conversation/ipc';
import { GitController } from '@/main/app-server/git/controller';
import { registerGitIpc } from '@/main/app-server/git/ipc';
import { registerMcpIpc } from '@/main/app-server/mcp/ipc';
import { McpConfigController } from '@/main/app-server/mcp/config-controller';
import { ModelConfigController } from '@/main/app-server/model-config/controller';
import { registerModelConfigIpc } from '@/main/app-server/model-config/ipc';
import { WorkspaceController } from '@/main/app-server/workspace/controller';
import { registerWorkspaceIpc } from '@/main/app-server/workspace/ipc';
import { PreviewController } from '@/main/preview/controller';
import { registerPreviewIpc } from '@/main/preview/ipc';
import { TerminalController } from '@/main/terminal/controller';
import { registerTerminalIpc } from '@/main/terminal/ipc';

let mainWindow: BrowserWindow | null = null;
let supervisor: ConnectionSupervisor | null = null;
let disposeConnectionIpc: (() => void) | null = null;
let disposeCommandApprovalIpc: (() => void) | null = null;
let disposeConversationIpc: (() => void) | null = null;
let disposeMcpIpc: (() => void) | null = null;
let disposeModelConfigIpc: (() => void) | null = null;
let disposeWorkspaceIpc: (() => void) | null = null;
let disposeWorkspaceConversationSubscription: (() => void) | null = null;
let disposeGitIpc: (() => void) | null = null;
let previewController: PreviewController | null = null;
let disposePreviewIpc: (() => void) | null = null;
let disposePreviewApprovalSubscriptions: (() => void) | null = null;
let terminalController: TerminalController | null = null;
let disposeTerminalIpc: (() => void) | null = null;

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
        previewController?.shutdown();
        terminalController?.rendererUnavailable();
      }
    },
  );
  window.webContents.on('render-process-gone', () => {
    supervisor?.approvalSurfacesUnavailable();
    previewController?.shutdown();
    terminalController?.rendererUnavailable();
  });
  window.once('closed', () => {
    supervisor?.approvalSurfacesUnavailable();
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
  supervisor = new ConnectionSupervisor({
    desktopAppPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    clientVersion: app.getVersion(),
  });
  const workspaceController = new WorkspaceController({
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
  disposeWorkspaceConversationSubscription =
    supervisor.conversation.subscribe(
      workspaceController.observeConversation,
    );
  terminalController = new TerminalController({
    dialog,
    getMainWindow: () => mainWindow,
    getWorkspace: workspaceController.getLaunchContext,
    getResolvedCli: supervisor.getResolvedCli,
    getCliEnvironment: () => ({ ...process.env }),
    isApprovalPending: () =>
      supervisor?.commandApprovals.getSnapshot().status === 'pending' ||
      supervisor?.mcpApprovals.getSnapshot().status === 'pending',
  });
  previewController = new PreviewController({
    dialog,
    getMainWindow: () => mainWindow,
    getWorkspaceState: workspaceController.getSnapshot,
    isApprovalPending: () =>
      supervisor?.commandApprovals.getSnapshot().status === 'pending' ||
      supervisor?.mcpApprovals.getSnapshot().status === 'pending',
  });
  disposeConnectionIpc = registerConnectionIpc({
    supervisor,
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeCommandApprovalIpc = registerCommandApprovalIpc({
    controller: supervisor.commandApprovals,
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeConversationIpc = registerConversationIpc({
    controller: supervisor.conversation,
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeMcpIpc = registerMcpIpc({
    session: supervisor.mcpSession,
    approvals: supervisor.mcpApprovals,
    config: new McpConfigController({ supervisor }),
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeModelConfigIpc = registerModelConfigIpc({
    controller: new ModelConfigController({ supervisor }),
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
      supervisor,
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
      supervisor?.commandApprovals.getSnapshot().status === 'pending' ||
      supervisor?.mcpApprovals.getSnapshot().status === 'pending';
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
    supervisor.commandApprovals.subscribe(hidePreviewForApproval);
  const unsubscribeMcpApproval =
    supervisor.mcpApprovals.subscribe(hidePreviewForApproval);
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
    terminalController?.shutdown();
    previewController?.shutdown();
    supervisor?.shutdown();
  });

  app.on('will-quit', () => {
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
    disposeWorkspaceConversationSubscription?.();
    disposeWorkspaceConversationSubscription = null;
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
