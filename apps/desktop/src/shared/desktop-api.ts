import type { CommandApprovalApi } from './command-approval';
import type { ConnectionApi } from './connection';
import type { ConversationApi } from './conversation';
import type { McpApi } from './mcp';
import type { ModelConfigApi } from './model-config';
import type { WorkspaceApi } from './workspace';

export type DesktopApi = Readonly<
  ConnectionApi &
    CommandApprovalApi &
    ConversationApi &
    McpApi &
    ModelConfigApi &
    WorkspaceApi
>;
