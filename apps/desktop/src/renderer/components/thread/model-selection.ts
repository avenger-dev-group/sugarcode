import type {
  ConversationModelSelection,
  ConversationTurn,
} from '@/shared/conversation';
import type {
  ModelProfileValue,
  ModelRequestOptions,
} from '@/shared/model-config';

export const latestDurableModelSelection = (
  turns: readonly ConversationTurn[],
): ConversationModelSelection | undefined => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const model = turns[index]?.model;
    if (model) {
      return model;
    }
  }
  return undefined;
};

export const latestDurableModelProfileId = (
  turns: readonly ConversationTurn[],
): string | undefined => latestDurableModelSelection(turns)?.profileId;

export const resolveModelProfileId = (
  explicitProfileId: string | undefined,
  durableProfileId: string | undefined,
  defaultProfileId: string,
): string => explicitProfileId ?? durableProfileId ?? defaultProfileId;

export const resolveModelRequestOptions = (
  explicit: ModelRequestOptions | undefined,
  durable: ModelRequestOptions | undefined,
  profile:
    | Pick<ModelProfileValue, 'reasoningEffort' | 'serviceTier'>
    | undefined,
): ModelRequestOptions =>
  explicit ?? {
    reasoningEffort:
      durable?.reasoningEffort ?? profile?.reasoningEffort ?? 'auto',
    serviceTier: durable?.serviceTier ?? profile?.serviceTier ?? 'auto',
  };

export const modelRequestOptionsEqual = (
  left: ModelRequestOptions,
  right: ModelRequestOptions,
): boolean =>
  left.reasoningEffort === right.reasoningEffort &&
  left.serviceTier === right.serviceTier;
