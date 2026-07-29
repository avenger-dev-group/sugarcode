import { app, BrowserWindow, dialog } from 'electron';
import started from 'electron-squirrel-startup';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { registerCommandApprovalIpc } from '@/main/app-server/command-approval/ipc';
import { registerConnectionIpc } from '@/main/app-server/connection/ipc';
import { ConnectionSupervisor } from '@/main/app-server/connection/supervisor';
import { registerConversationIpc } from '@/main/app-server/conversation/ipc';
import { registerMcpIpc } from '@/main/app-server/mcp/ipc';
import { McpConfigController } from '@/main/app-server/mcp/config-controller';
import { ModelConfigController } from '@/main/app-server/model-config/controller';
import { registerModelConfigIpc } from '@/main/app-server/model-config/ipc';
import { WorkspaceController } from '@/main/app-server/workspace/controller';
import { registerWorkspaceIpc } from '@/main/app-server/workspace/ipc';

let mainWindow: BrowserWindow | null = null;
let supervisor: ConnectionSupervisor | null = null;
let disposeConnectionIpc: (() => void) | null = null;
let disposeCommandApprovalIpc: (() => void) | null = null;
let disposeConversationIpc: (() => void) | null = null;
let disposeMcpIpc: (() => void) | null = null;
let disposeModelConfigIpc: (() => void) | null = null;
let disposeWorkspaceIpc: (() => void) | null = null;

const rendererFilePath = path.join(
  __dirname,
  `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
);

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
    width: 800,
    height: 600,
    minWidth: 360,
    minHeight: 480,
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
        supervisor?.commandApprovals.surfaceUnavailable();
        supervisor?.mcpApprovals.surfaceUnavailable();
      }
    },
  );
  window.webContents.on('render-process-gone', () => {
    supervisor?.commandApprovals.surfaceUnavailable();
    supervisor?.mcpApprovals.surfaceUnavailable();
  });
  window.once('closed', () => {
    supervisor?.commandApprovals.surfaceUnavailable();
    supervisor?.mcpApprovals.surfaceUnavailable();
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
  });
  await workspaceController.restore();
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
  });
}
