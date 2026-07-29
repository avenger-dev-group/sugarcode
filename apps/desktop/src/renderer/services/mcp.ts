import type {
  McpApprovalActionResult,
  McpApprovalStateSnapshot,
  McpSessionActionResult,
  McpSessionStateSnapshot,
} from '@/shared/mcp';

export const getMcpSessionState = (): Promise<McpSessionStateSnapshot> =>
  window.sugarcode.getMcpSessionState();
export const onMcpSessionStateChanged = (
  listener: (snapshot: McpSessionStateSnapshot) => void,
): (() => void) => window.sugarcode.onMcpSessionStateChanged(listener);
export const toggleMcpServer = (
  serverId: string,
): Promise<McpSessionActionResult> =>
  window.sugarcode.toggleMcpServer(serverId);
export const enableMcpSession = (): Promise<McpSessionActionResult> =>
  window.sugarcode.enableMcpSession();
export const disableMcpSession = (): Promise<McpSessionActionResult> =>
  window.sugarcode.disableMcpSession();

export const getMcpApprovalState = (): Promise<McpApprovalStateSnapshot> =>
  window.sugarcode.getMcpApprovalState();
export const onMcpApprovalStateChanged = (
  listener: (snapshot: McpApprovalStateSnapshot) => void,
): (() => void) => window.sugarcode.onMcpApprovalStateChanged(listener);
export const approveMcpCall = (
  presentationId: string,
): Promise<McpApprovalActionResult> =>
  window.sugarcode.approveMcpCall(presentationId);
export const denyMcpCall = (
  presentationId: string,
): Promise<McpApprovalActionResult> =>
  window.sugarcode.denyMcpCall(presentationId);
