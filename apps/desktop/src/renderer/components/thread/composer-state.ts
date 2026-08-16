import type { WorkspaceStateSnapshot } from '@/shared/workspace';
import type { ConversationPhase } from '@/shared/conversation';

export const TURN_STOP_SAFETY_DELAY_MS = 1_000;

export type ComposerSurface = 'approval' | 'userInput' | 'composer';

export type ConversationTurnStartState = Readonly<{
  phase: ConversationPhase;
  startsChatOnSend: boolean;
  hasPendingThreadSelection: boolean;
  hasPendingMutation: boolean;
  isSending: boolean;
  isEditingMessage: boolean;
  hasUsableModel: boolean;
}>;

export const resolveComposerSurface = (
  hasApproval: boolean,
  hasUserInput: boolean,
): ComposerSurface => {
  if (hasApproval) return 'approval';
  if (hasUserInput) return 'userInput';
  return 'composer';
};

export const shouldShowStopControl = (
  phase: ConversationPhase,
  isSending: boolean,
): boolean =>
  isSending ||
  phase === 'starting' ||
  phase === 'inProgress' ||
  phase === 'stopping';

export const canStopTurn = (
  phase: ConversationPhase,
  activeTurnId: string | null,
  stopUnlockedTurnId: string | null,
): boolean =>
  phase === 'inProgress' &&
  activeTurnId !== null &&
  stopUnlockedTurnId === activeTurnId;

export const shouldStartChatOnSend = (
  workspace: WorkspaceStateSnapshot,
): boolean =>
  workspace.kind === undefined &&
  (workspace.status === 'unselected' || workspace.status === 'failed');

export const canStartConversationTurn = ({
  phase,
  startsChatOnSend,
  hasPendingThreadSelection,
  hasPendingMutation,
  isSending,
  isEditingMessage,
  hasUsableModel,
}: ConversationTurnStartState): boolean =>
  (
    phase === 'idle' ||
    phase === 'ready' ||
    phase === 'starting' ||
    phase === 'inProgress' ||
    phase === 'stopping' ||
    startsChatOnSend
  ) &&
  !hasPendingThreadSelection &&
  !hasPendingMutation &&
  !isSending &&
  !isEditingMessage &&
  hasUsableModel;

export const canRemoveDraftProject = (
  workspace: WorkspaceStateSnapshot,
  threadIdentity: string | null,
): boolean =>
  workspace.status === 'ready' &&
  workspace.kind === 'project' &&
  threadIdentity === null;
