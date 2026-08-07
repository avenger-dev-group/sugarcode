import type {
  CommandApprovalStateSnapshot,
  CommandApprovalViewModel,
  CommandApprovalMode,
} from '@/shared/command-approval';

export type CommandApprovalRequestViewModel = CommandApprovalViewModel;

export type CommandApprovalStore = Readonly<{
  snapshot: CommandApprovalStateSnapshot;
  request: CommandApprovalRequestViewModel | null;
  isOpen: boolean;
  canAct: boolean;
  secondsRemaining: number;
  selectedMode: CommandApprovalMode;
  modePending: boolean;
  actionError: string | null;
  setSelectedMode: (mode: CommandApprovalMode) => void;
  changeMode: (
    mode: CommandApprovalMode,
    threadId?: string,
    workspaceId?: string,
  ) => Promise<void>;
  approve: () => Promise<void>;
  deny: () => Promise<void>;
}>;

export type CommandApprovalViewProps = Readonly<{
  store: CommandApprovalStore;
  activeThreadId: string | null;
}>;

export type CommandApprovalModeControlProps = Readonly<{
  store: CommandApprovalStore;
  threadId: string | null;
  workspaceId: string | null;
  disabled: boolean;
}>;
