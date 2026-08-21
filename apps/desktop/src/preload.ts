import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { createDesktopApi } from '@/preload/desktop-api';

contextBridge.exposeInMainWorld(
  'sugarcode',
  createDesktopApi(ipcRenderer, (file) => webUtils.getPathForFile(file)),
);
