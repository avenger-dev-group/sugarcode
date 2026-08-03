import type { ConversationTurn } from '@/shared/conversation';

export const latestDurableModelProfileId = (
  turns: readonly ConversationTurn[],
): string | undefined => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const profileId = turns[index]?.model?.profileId;
    if (profileId) {
      return profileId;
    }
  }
  return undefined;
};

export const resolveModelProfileId = (
  explicitProfileId: string | undefined,
  durableProfileId: string | undefined,
  defaultProfileId: string,
): string => explicitProfileId ?? durableProfileId ?? defaultProfileId;
