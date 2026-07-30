import type { CommandApprovalApi } from './command-approval';
import type { ConnectionApi } from './connection';
import type { ConversationApi } from './conversation';
import type { McpApi } from './mcp';
import type { ModelConfigApi } from './model-config';
import type { WorkspaceApi } from './workspace';
import type { GitApi } from './git';
import type { PreviewApi } from './preview';

export type DesktopApi = Readonly<
  ConnectionApi &
    CommandApprovalApi &
    ConversationApi &
    McpApi &
    ModelConfigApi &
    WorkspaceApi &
    GitApi &
    PreviewApi
>;
