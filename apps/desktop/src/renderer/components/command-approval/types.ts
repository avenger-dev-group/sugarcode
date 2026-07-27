import type {
  CommandApprovalStateSnapshot,
  CommandApprovalViewModel,
} from '@/shared/command-approval';

export type CommandApprovalRequestViewModel = CommandApprovalViewModel;

export type CommandApprovalStore = Readonly<{
  snapshot: CommandApprovalStateSnapshot;
  request: CommandApprovalRequestViewModel | null;
  isOpen: boolean;
  canAct: boolean;
  secondsRemaining: number;
  statusMessage: string;
  actionError: string | null;
  approve: () => Promise<void>;
  deny: () => Promise<void>;
}>;

export type CommandApprovalViewProps = Readonly<{
  store: CommandApprovalStore;
}>;
