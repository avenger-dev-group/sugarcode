import type { CommandApprovalApi } from './command-approval';
import type { ConnectionApi } from './connection';
import type { ConversationApi } from './conversation';
import type { McpApi } from './mcp';
import type { ModelConfigApi } from './model-config';
import type { SkillsApi } from './skills';
import type { WorkspaceApi } from './workspace';
import type { GitApi } from './git';
import type { PreviewApi } from './preview';
import type { TerminalApi } from './terminal';

export type DesktopApi = Readonly<
  ConnectionApi &
    CommandApprovalApi &
    ConversationApi &
    McpApi &
    ModelConfigApi &
    SkillsApi &
    WorkspaceApi &
    GitApi &
    PreviewApi &
    TerminalApi
>;
