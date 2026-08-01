import type {
  CommandApprovalActionResult,
  CommandApprovalMode,
  CommandApprovalStateListener,
  CommandApprovalStateSnapshot,
} from '@/shared/command-approval';

export const getCommandApprovalState =
  (): Promise<CommandApprovalStateSnapshot> =>
    window.sugarcode.getCommandApprovalState();

export const onCommandApprovalStateChanged = (
  listener: CommandApprovalStateListener,
): (() => void) => window.sugarcode.onCommandApprovalStateChanged(listener);

export const approveCommand = (
  presentationId: string,
  mode: CommandApprovalMode,
): Promise<CommandApprovalActionResult> =>
  window.sugarcode.approveCommand(presentationId, mode);

export const denyCommand = (
  presentationId: string,
): Promise<CommandApprovalActionResult> =>
  window.sugarcode.denyCommand(presentationId);

export const setCommandApprovalMode = (
  mode: CommandApprovalMode,
  threadId?: string,
): Promise<CommandApprovalActionResult> =>
  window.sugarcode.setCommandApprovalMode(mode, threadId);
