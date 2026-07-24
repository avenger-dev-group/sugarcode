import { contextBridge, ipcRenderer } from 'electron';

import { createDesktopApi } from '@/preload/desktop-api';

contextBridge.exposeInMainWorld('sugarcode', createDesktopApi(ipcRenderer));
