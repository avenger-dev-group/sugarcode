import type { CommandApprovalRequestViewModel } from './types';

const SHELL_MODE_PREFIX = /^(?:Full Access|Sandboxed):\s*/u;

export const commandApprovalDisplayCommand = (
  request: Pick<CommandApprovalRequestViewModel, 'command' | 'operationKind'>,
): string =>
  request.operationKind === 'shell'
    ? request.command.replace(SHELL_MODE_PREFIX, '')
    : request.command;
