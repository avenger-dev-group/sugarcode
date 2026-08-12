import type {
  CommandApprovalStateSnapshot,
  CommandApprovalViewModel,
  CommandApprovalMode,
} from '@/shared/command-approval';

export type CommandApprovalRequestViewModel = CommandApprovalViewModel;

export type CommandApprovalStore = Readonly<{
  snapshot: CommandApprovalStateSnapshot;
  request: CommandApprovalRequestViewModel | null;
  requests: readonly CommandApprovalRequestViewModel[];
  isOpen: boolean;
  canAct: (request: CommandApprovalRequestViewModel) => boolean;
  secondsRemaining: (request: CommandApprovalRequestViewModel) => number;
  selectedMode: (
    request: CommandApprovalRequestViewModel,
  ) => CommandApprovalMode;
  modePending: boolean;
  actionError: string | null;
  setSelectedMode: (
    presentationId: string,
    mode: CommandApprovalMode,
  ) => void;
  changeMode: (
    mode: CommandApprovalMode,
    threadId?: string,
    workspaceId?: string,
  ) => Promise<void>;
  approve: (request: CommandApprovalRequestViewModel) => Promise<void>;
  deny: (request: CommandApprovalRequestViewModel) => Promise<void>;
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
