import { app, BrowserWindow } from 'electron';
import started from 'electron-squirrel-startup';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { registerConnectionIpc } from '@/main/app-server/connection-ipc';
import { ConnectionSupervisor } from '@/main/app-server/connection-supervisor';

let mainWindow: BrowserWindow | null = null;
let supervisor: ConnectionSupervisor | null = null;
let disposeConnectionIpc: (() => void) | null = null;

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
    minWidth: 560,
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
  window.once('closed', () => {
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
  disposeConnectionIpc = registerConnectionIpc({
    supervisor,
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
  });
}
