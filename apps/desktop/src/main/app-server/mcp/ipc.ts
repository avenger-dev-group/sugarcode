import { ipcMain } from 'electron';

import {
  MCP_APPROVAL_APPROVE_CHANNEL,
  MCP_APPROVAL_DENY_CHANNEL,
  MCP_APPROVAL_STATE_CHANGED_CHANNEL,
  MCP_APPROVAL_STATE_GET_CHANNEL,
  MCP_CONFIG_GET_CHANNEL,
  MCP_CONFIG_SAVE_CHANNEL,
  MCP_SESSION_DISABLE_CHANNEL,
  MCP_SESSION_ENABLE_CHANNEL,
  MCP_SESSION_STATE_CHANGED_CHANNEL,
  MCP_SESSION_STATE_GET_CHANNEL,
  MCP_SESSION_TOGGLE_CHANNEL,
} from '@/shared/mcp';

import type { McpApprovalController } from './approval-controller';
import type { McpConfigController } from './config-controller';
import type { McpSessionController } from './session-controller';
import {
  getTrustedMainWindow,
  isTrustedIpcSender,
  type IpcSenderValidationOptions,
} from '../ipc/trusted-sender';

type McpIpcOptions = IpcSenderValidationOptions &
  Readonly<{
    session: McpSessionController;
    approvals: McpApprovalController;
    config?: McpConfigController;
  }>;

export const registerMcpIpc = (options: McpIpcOptions): (() => void) => {
  const trusted = (event: Electron.IpcMainInvokeEvent): void => {
    if (!isTrustedIpcSender(event, options)) {
      throw new Error('MCP request came from an untrusted frame.');
    }
  };
  ipcMain.handle(MCP_SESSION_STATE_GET_CHANNEL, (event) => {
    trusted(event);
    return options.session.getSnapshot();
  });
  if (options.config) {
    ipcMain.handle(MCP_CONFIG_GET_CHANNEL, (event) => {
      trusted(event);
      return options.config?.inspect();
    });
    ipcMain.handle(MCP_CONFIG_SAVE_CHANNEL, (event, request: unknown) => {
      trusted(event);
      return options.config?.save(request);
    });
  }
  ipcMain.handle(MCP_SESSION_TOGGLE_CHANNEL, (event, serverId: unknown) => {
    trusted(event);
    return options.session.toggle(serverId);
  });
  ipcMain.handle(MCP_SESSION_ENABLE_CHANNEL, async (event) => {
    trusted(event);
    return options.session.enable();
  });
  ipcMain.handle(MCP_SESSION_DISABLE_CHANNEL, async (event) => {
    trusted(event);
    return options.session.disable();
  });
  ipcMain.handle(MCP_APPROVAL_STATE_GET_CHANNEL, (event) => {
    trusted(event);
    return options.approvals.markSurfaceReady();
  });
  ipcMain.handle(
    MCP_APPROVAL_APPROVE_CHANNEL,
    async (event, presentationId: unknown) => {
      trusted(event);
      return options.approvals.approve(presentationId);
    },
  );
  ipcMain.handle(
    MCP_APPROVAL_DENY_CHANNEL,
    async (event, presentationId: unknown) => {
      trusted(event);
      return options.approvals.deny(presentationId);
    },
  );
  const unsubscribeSession = options.session.subscribe((snapshot) => {
    getTrustedMainWindow(options)?.webContents.send(
      MCP_SESSION_STATE_CHANGED_CHANNEL,
      snapshot,
    );
  });
  const unsubscribeApproval = options.approvals.subscribe((snapshot) => {
    getTrustedMainWindow(options)?.webContents.send(
      MCP_APPROVAL_STATE_CHANGED_CHANNEL,
      snapshot,
    );
  });
  return () => {
    unsubscribeSession();
    unsubscribeApproval();
    options.approvals.surfaceUnavailable();
    for (const channel of [
      MCP_SESSION_STATE_GET_CHANNEL,
      MCP_SESSION_TOGGLE_CHANNEL,
      MCP_SESSION_ENABLE_CHANNEL,
      MCP_SESSION_DISABLE_CHANNEL,
      MCP_APPROVAL_STATE_GET_CHANNEL,
      MCP_APPROVAL_APPROVE_CHANNEL,
      MCP_APPROVAL_DENY_CHANNEL,
      ...(options.config
        ? [MCP_CONFIG_GET_CHANNEL, MCP_CONFIG_SAVE_CHANNEL]
        : []),
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
};
