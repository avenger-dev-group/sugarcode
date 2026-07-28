import type { CommandApprovalApi } from './command-approval';
import type { ConnectionApi } from './connection';
import type { ConversationApi } from './conversation';

export type DesktopApi = Readonly<
  ConnectionApi & CommandApprovalApi & ConversationApi
>;
