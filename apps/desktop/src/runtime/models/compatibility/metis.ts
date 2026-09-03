import type { ModelReasoningEffort } from '../../../shared/model-config.ts';

export const isMetisModel = (model: string): boolean =>
  model.toLowerCase().startsWith('metis');

// Metis defaults to an undifferentiated content stream unless thinking is
// explicitly requested. Keep this wire policy separate from text parsing.
export const resolveReasoningEffort = (
  model: string,
  effort: ModelReasoningEffort | undefined,
): Exclude<ModelReasoningEffort, 'auto'> | undefined =>
  effort === undefined || effort === 'auto'
    ? isMetisModel(model) ? 'high' : undefined
    : effort;

export const metisChatThinking = (
  model: string,
  effort: ModelReasoningEffort | undefined,
): { type: 'enabled' | 'disabled' } | undefined =>
  isMetisModel(model)
    ? { type: effort === 'none' ? 'disabled' : 'enabled' }
    : undefined;

export const metisAnthropicThinking = (
  model: string,
  effort: ModelReasoningEffort | undefined,
): { type: 'adaptive' } | { type: 'disabled' } | undefined =>
  isMetisModel(model)
    ? { type: effort === 'none' ? 'disabled' : 'adaptive' }
    : undefined;
