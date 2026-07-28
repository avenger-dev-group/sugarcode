import type {
  ConversationActionResult,
  ConversationStateListener,
  ConversationStateSnapshot,
} from '@/shared/conversation';

const desktopApi = (): Window['sugarcode'] => window.sugarcode;

export const getConversationState =
  (): Promise<ConversationStateSnapshot> =>
    desktopApi().getConversationState();

export const onConversationStateChanged = (
  listener: ConversationStateListener,
): (() => void) => desktopApi().onConversationStateChanged(listener);

export const sendConversationMessage = (
  input: string,
): Promise<ConversationActionResult> =>
  desktopApi().sendConversationMessage(input);

export const stopConversationTurn =
  (): Promise<ConversationActionResult> =>
    desktopApi().stopConversationTurn();
