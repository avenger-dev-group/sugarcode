import type {
  CommandApprovalActionResult,
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
): Promise<CommandApprovalActionResult> =>
  window.sugarcode.approveCommand(presentationId);

export const denyCommand = (
  presentationId: string,
): Promise<CommandApprovalActionResult> =>
  window.sugarcode.denyCommand(presentationId);
