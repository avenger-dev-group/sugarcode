import { app, BrowserWindow, dialog, Menu, shell, Tray } from 'electron';
import started from 'electron-squirrel-startup';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { registerCommandApprovalIpc } from '@/main/ipc/command-approval';
import { registerCommandEnvironmentIpc } from '@/main/ipc/command-environment';
import { registerConnectionIpc } from '@/main/ipc/connection';
import { registerConversationIpc } from '@/main/ipc/conversation';
import { registerGitIpc } from '@/main/ipc/git';
import { registerMcpIpc } from '@/main/ipc/mcp';
import { registerModelConfigIpc } from '@/main/ipc/model-config';
import { registerSkillsIpc } from '@/main/ipc/skills';
import { registerKnowledgeIpc } from '@/main/ipc/knowledge';
import { registerWorkspaceIpc } from '@/main/ipc/workspace';
import { GitController } from '@/main/git/controller';
import { McpSessionController } from '@/main/mcp/session-controller';
import { ThreadRegistry } from '@/main/navigation/thread-registry';
import { WorkspaceController } from '@/main/workspace/controller';
import { PreviewController } from '@/main/preview/controller';
import { registerPreviewIpc } from '@/main/preview/ipc';
import { TerminalController } from '@/main/terminal/controller';
import { registerTerminalIpc } from '@/main/terminal/ipc';
import { RuntimeSupervisor } from '@/main/runtime/supervisor';
import { RuntimeModelConfigController } from '@/main/runtime/model-config-controller';
import { RuntimeConversationController } from '@/main/runtime/conversation-controller';
import { RuntimeConnectionController } from '@/main/runtime/connection-controller';
import { RuntimeApprovalController } from '@/main/runtime/approval-controller';
import { RuntimeCommandEnvironmentController } from '@/main/runtime/command-environment-controller';
import { RuntimeGitAdapter } from '@/main/runtime/git-adapter';
import { RuntimeMcpConfigController } from '@/main/runtime/mcp-config-controller';
import { RuntimeMcpApprovalController } from '@/main/runtime/mcp-approval-controller';
import { RuntimeSkillsController } from '@/main/runtime/skills-controller';
import { RuntimeKnowledgeController } from '@/main/runtime/knowledge-controller';
import { RuntimeWorkspaceAdapter } from '@/main/runtime/workspace-adapter';
import { UpdateController } from '@/main/update/controller';
import { registerUpdateIpc } from '@/main/update/ipc';
import { runDesktopE2EProbe } from '@/main/e2e-probe';

const processStartedAtMs = Date.now();
const e2eRoot = process.env.SUGARCODE_E2E_PROBE === '1'
  ? process.env.SUGARCODE_E2E_ROOT
  : undefined;
if (e2eRoot) {
  app.setPath('userData', path.join(e2eRoot, 'user-data'));
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let hasShownTrayHint = false;
let runtimeConnectionController: RuntimeConnectionController | null = null;
let disposeConnectionIpc: (() => void) | null = null;
let disposeCommandApprovalIpc: (() => void) | null = null;
let disposeCommandEnvironmentIpc: (() => void) | null = null;
let disposeConversationIpc: (() => void) | null = null;
let disposeMcpIpc: (() => void) | null = null;
let disposeModelConfigIpc: (() => void) | null = null;
let disposeSkillsIpc: (() => void) | null = null;
let disposeKnowledgeIpc: (() => void) | null = null;
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
let gitController: GitController | null = null;
let updateController: UpdateController | null = null;
let disposeUpdateIpc: (() => void) | null = null;

const rendererFilePath = path.join(
  __dirname,
  `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
);
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(app.getAppPath(), 'assets', 'icon.png');

const updatePlatform = (): 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | null => {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'darwin-arm64';
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return 'darwin-x64';
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'win32-x64';
  }
  return null;
};

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
    show: false,
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

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show();
    }
  });
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
        runtimeApprovalController?.surfaceUnavailable();
        previewController?.shutdown();
        terminalController?.rendererUnavailable();
      }
    },
  );
  window.webContents.on('render-process-gone', () => {
    runtimeApprovalController?.surfaceUnavailable();
    runtimeMcpApprovalController?.surfaceUnavailable();
    previewController?.shutdown();
    terminalController?.rendererUnavailable();
  });
  window.on('close', (event) => {
    const shouldHide =
      !isQuitting && (process.platform === 'darwin' || tray !== null);
    if (shouldHide) {
      event.preventDefault();
      window.hide();
      if (process.platform === 'win32' && tray && !hasShownTrayHint) {
        hasShownTrayHint = true;
        tray.displayBalloon({
          title: 'SugarCode is still running',
          content:
            'Agent tasks continue in the background. Use the system tray icon to reopen or quit SugarCode.',
          iconType: 'info',
        });
      }
    }
  });
  window.once('closed', () => {
    runtimeApprovalController?.surfaceUnavailable();
    previewController?.shutdown();
    terminalController?.rendererUnavailable();
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    if (!e2eRoot) window.webContents.openDevTools();
  } else {
    void window.loadFile(rendererFilePath);
  }
  const reportPath = e2eRoot ? process.env.SUGARCODE_E2E_REPORT : undefined;
  if (reportPath) {
    window.webContents.once('did-finish-load', () => {
      void runDesktopE2EProbe(window, reportPath, processStartedAtMs);
    });
  }
};

const showMainWindow = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
};

const hasActiveWork = (): boolean => {
  const phase = runtimeConversationController?.getSnapshot().phase;
  return (
    phase === 'starting' ||
    phase === 'inProgress' ||
    phase === 'stopping' ||
    runtimeApprovalController?.getSnapshot().status === 'pending' ||
    runtimeMcpApprovalController?.getSnapshot().status === 'pending' ||
    gitController?.getSnapshot().pending !== undefined ||
    terminalController?.hasLiveSession() === true
  );
};

const requestQuitApplication = async (): Promise<void> => {
  if (hasActiveWork()) {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: 'Quit SugarCode?',
      message: 'SugarCode still has work running.',
      detail: 'Quitting will stop active Agent tasks and terminal sessions.',
      buttons: ['Cancel', 'Quit SugarCode'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) {
      return;
    }
  }
  app.quit();
};

const createTray = (): void => {
  if (process.platform !== 'win32' || tray) {
    return;
  }
  try {
    tray = new Tray(appIconPath);
    tray.setToolTip('SugarCode');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open SugarCode', click: showMainWindow },
        { type: 'separator' },
        {
          label: 'Quit SugarCode',
          click: () => void requestQuitApplication(),
        },
      ]),
    );
    tray.on('click', showMainWindow);
  } catch (error) {
    tray = null;
    console.error('Failed to create the Windows system tray icon.', error);
  }
};

const startApplication = async (): Promise<void> => {
  await app.whenReady();
  const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const ffmpegCandidates = [
    process.env.SUGARCODE_FFMPEG_PATH,
    path.join(process.resourcesPath, 'ffmpeg', ffmpegName),
    path.join(process.resourcesPath, ffmpegName),
    ...(process.platform === 'darwin'
      ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
      : process.platform === 'linux'
        ? ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']
        : []),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const resolvedFfmpegPath =
    ffmpegCandidates.find((candidate) => existsSync(candidate)) ?? ffmpegName;
  runtimeSupervisor = new RuntimeSupervisor({
    runtimePath: path.join(__dirname, 'runtime.mjs'),
    dataDirectory: e2eRoot
      ? path.join(e2eRoot, 'data')
      : path.join(app.getPath('home'), '.sugarcode', 'v3'),
    nativeModulePath: app.isPackaged
      ? path.join(process.resourcesPath, 'sugarcode-desktop-native.node')
      : path.join(app.getAppPath(), 'native', 'sugarcode-desktop-native.node'),
    ffmpegPath: resolvedFfmpegPath,
  });
  disposeRuntimeEvents = runtimeSupervisor.subscribe((event) => {
    if (event.type === 'runtime.log') {
      const log = event.level === 'debug' ? console.debug : console[event.level];
      log(`[runtime] ${event.message}`);
    } else if (event.type === 'runtime.ready') {
      console.info(`[runtime] protocol ${event.protocolVersion} ready`);
    } else if (
      event.type === 'mcp.sessionAction' &&
      event.action.accepted
    ) {
      runtimeMcpSessionController?.synchronizeActive(event.activeServerIds);
    }
  });
  runtimeSupervisor.start();
  runtimeConnectionController = new RuntimeConnectionController(
    runtimeSupervisor,
  );
  runtimeConversationController = new RuntimeConversationController(
    runtimeSupervisor,
  );
  runtimeApprovalController = new RuntimeApprovalController(runtimeSupervisor);
  runtimeMcpApprovalController = new RuntimeMcpApprovalController(
    runtimeSupervisor,
    (workspaceId, threadId) =>
      runtimeApprovalController?.isAutoApproved(workspaceId, threadId) === true,
  );
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
        return event?.action ?? { accepted: false, reason: 'unavailable' };
      } catch {
        return { accepted: false, reason: 'unavailable' };
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
  runtimeConversationController.subscribe((snapshot) => {
    runtimeGitAdapter?.selectThread(snapshot.workspaceId, snapshot.threadId);
  });
  const threadRegistry = new ThreadRegistry();
  const workspaceRuntime = new RuntimeWorkspaceAdapter({
    runtime: runtimeSupervisor,
    connection: runtimeConnectionController,
    conversation: runtimeConversationController,
    threadRegistry,
    getWorkspaceSwitchBlock: () => null,
    onWorkspaceOpened: (workspaceId, canonicalRoot) => {
      runtimeApprovalController?.openWorkspace(workspaceId, canonicalRoot);
      runtimeMcpApprovalController?.openWorkspace(workspaceId, canonicalRoot);
      runtimeGitAdapter?.openWorkspace(workspaceId);
    },
  });
  const workspaceController = new WorkspaceController({
    threadRegistry,
    supervisor: workspaceRuntime,
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
  terminalController = new TerminalController({
    runtime: runtimeSupervisor,
    getWorkspace: workspaceController.getLaunchContext,
    isApprovalPending: () =>
      runtimeApprovalController?.getSnapshot().status === 'pending' ||
      runtimeMcpApprovalController?.getSnapshot().status === 'pending',
  });
  previewController = new PreviewController({
    dialog,
    getMainWindow: () => mainWindow,
    getWorkspaceState: workspaceController.getSnapshot,
    getWorkspace: workspaceController.getLaunchContext,
    openExternal: (url) => shell.openExternal(url),
    openPath: async (filePath) => {
      const error = await shell.openPath(filePath);
      if (error) {
        throw new Error(error);
      }
    },
    showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
    isApprovalPending: () =>
      runtimeApprovalController?.getSnapshot().status === 'pending' ||
      runtimeMcpApprovalController?.getSnapshot().status === 'pending',
  });
  disposeConnectionIpc = registerConnectionIpc({
    supervisor: runtimeConnectionController,
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
  disposeSkillsIpc = registerSkillsIpc({
    controller: new RuntimeSkillsController({
      runtime: runtimeSupervisor,
      dialog,
      getMainWindow: () => mainWindow,
      getWorkspace: workspaceController.getLaunchContext,
    }),
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeKnowledgeIpc = registerKnowledgeIpc({
    controller: new RuntimeKnowledgeController({
      runtime: runtimeSupervisor,
      dialog,
      getMainWindow: () => mainWindow,
      getWorkspace: workspaceController.getLaunchContext,
      shell,
    }),
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeCommandEnvironmentIpc = registerCommandEnvironmentIpc({
    controller: new RuntimeCommandEnvironmentController(runtimeSupervisor),
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  disposeWorkspaceIpc = registerWorkspaceIpc({
    controller: workspaceController,
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  gitController = new GitController({
    supervisor: runtimeGitAdapter,
    workspace: workspaceController,
  });
  disposeGitIpc = registerGitIpc({
    controller: gitController,
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
  updateController = new UpdateController({
    currentVersion: app.getVersion(),
    platform: updatePlatform(),
    downloadsDirectory: app.getPath('downloads'),
    pendingStatePath: path.join(app.getPath('userData'), 'pending-update-v1.json'),
    sources: [
      {
        kind: 'gitcode',
        latestReleaseApiUrl:
          'https://api.gitcode.com/api/v5/repos/Simoonf/SugarCode/releases/latest?type=latest',
        downloadPageUrl: 'https://gitcode.com/Simoonf/SugarCode/releases',
      },
      {
        kind: 'github',
        latestReleaseApiUrl:
          'https://api.github.com/repos/avenger-dev-group/sugarcode/releases/latest',
        downloadPageUrl:
          'https://github.com/avenger-dev-group/sugarcode/releases/latest',
      },
    ],
    getInstallBlock: () => {
      const phase = runtimeConversationController?.getSnapshot().phase;
      return (
        phase === 'starting' ||
        phase === 'inProgress' ||
        phase === 'stopping' ||
        runtimeApprovalController?.getSnapshot().status === 'pending' ||
        runtimeMcpApprovalController?.getSnapshot().status === 'pending' ||
        gitController?.getSnapshot().pending !== undefined ||
        terminalController?.hasLiveSession() === true
      );
    },
    launchInstaller: async (installerPath) => {
      if (process.platform === 'darwin') {
        return (await shell.openPath(installerPath)) === '';
      }
      if (process.platform === 'win32') {
        const installer = spawn(installerPath, [], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        installer.unref();
        return true;
      }
      return false;
    },
    openDownloadPage: async (url) => {
      await shell.openExternal(url);
      return true;
    },
    quitApplication: () => app.quit(),
  });
  disposeUpdateIpc = registerUpdateIpc({
    controller: updateController,
    getMainWindow: () => mainWindow,
    isAllowedUrl: isAllowedRendererUrl,
  });
  const hidePreviewForApproval = (): void => {
    const approvalPending =
      runtimeApprovalController?.getSnapshot().status === 'pending' ||
      runtimeMcpApprovalController?.getSnapshot().status === 'pending';
    if (!approvalPending) {
      terminalController?.resumeAfterApproval();
      previewController?.resumeAfterApproval();
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
  const unsubscribeCommandApproval = runtimeApprovalController.subscribe(() => {
    runtimeMcpApprovalController?.refreshPolicy();
    hidePreviewForApproval();
  });
  const unsubscribeMcpApproval =
    runtimeMcpApprovalController.subscribe(hidePreviewForApproval);
  disposePreviewApprovalSubscriptions = () => {
    unsubscribeCommandApproval();
    unsubscribeMcpApproval();
  };
  createTray();
  createWindow();
  if (app.isPackaged) {
    void updateController.start();
  }
};

if (started) {
  app.quit();
} else if (process.platform === 'win32' && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const startApplicationPromise = startApplication();
  void startApplicationPromise;

  app.on('second-instance', () => {
    void startApplicationPromise.then(showMainWindow);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    showMainWindow();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    runtimeSupervisor?.shutdown();
    terminalController?.shutdown();
    previewController?.shutdown();
  });

  app.on('will-quit', () => {
    tray?.destroy();
    tray = null;
    updateController?.stop();
    updateController = null;
    runtimeSupervisor?.shutdown();
    runtimeSupervisor = null;
    runtimeConversationController = null;
    runtimeConnectionController = null;
    runtimeApprovalController = null;
    runtimeGitAdapter = null;
    disposeRuntimeEvents?.();
    disposeRuntimeEvents = null;
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
    disposeSkillsIpc?.();
    disposeSkillsIpc = null;
    disposeKnowledgeIpc?.();
    disposeKnowledgeIpc = null;
    disposeCommandEnvironmentIpc?.();
    disposeCommandEnvironmentIpc = null;
    disposeWorkspaceIpc?.();
    disposeWorkspaceIpc = null;
    disposeGitIpc?.();
    disposeGitIpc = null;
    gitController = null;
    disposeUpdateIpc?.();
    disposeUpdateIpc = null;
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
