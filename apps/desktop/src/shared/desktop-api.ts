import type { CommandApprovalApi } from './command-approval';
import type { ConnectionApi } from './connection';
import type { ConversationApi } from './conversation';
import type { McpApi } from './mcp';
import type { ModelConfigApi } from './model-config';
import type { SkillsApi } from './skills';
import type { KnowledgeApi } from './knowledge';
import type { WorkspaceApi } from './workspace';
import type { GitApi } from './git';
import type { PreviewApi } from './preview';
import type { TerminalApi } from './terminal';
import type { UpdateApi } from './update';
import type { CommandEnvironmentApi } from './command-environment';
import type { ExperimentalApi } from './experimental';

export type DesktopApi = Readonly<
  ConnectionApi &
    CommandApprovalApi &
    ConversationApi &
    McpApi &
    ModelConfigApi &
    SkillsApi &
    KnowledgeApi &
    WorkspaceApi &
    GitApi &
    PreviewApi &
    TerminalApi &
    CommandEnvironmentApi &
    ExperimentalApi &
    UpdateApi
>;
