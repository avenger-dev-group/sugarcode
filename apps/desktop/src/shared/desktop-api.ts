import type { CommandApprovalApi } from './command-approval';
import type { ConnectionApi } from './connection';
import type { ConversationApi } from './conversation';
import type { McpApi } from './mcp';

export type DesktopApi = Readonly<
  ConnectionApi & CommandApprovalApi & ConversationApi & McpApi
>;
