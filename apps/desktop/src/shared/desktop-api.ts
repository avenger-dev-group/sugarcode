import type { CommandApprovalApi } from './command-approval';
import type { ConnectionApi } from './connection';

export type DesktopApi = Readonly<ConnectionApi & CommandApprovalApi>;
