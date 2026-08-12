import type {
  ModelProviderFamily,
  ModelWireApi,
} from './model-config.ts';

type KnownModel = Readonly<{
  pattern: RegExp;
  contextWindowTokens: number;
}>;

const OPENAI_MODELS: readonly KnownModel[] = [
  { pattern: /^gpt-5(?:[.-]|$)/u, contextWindowTokens: 400_000 },
  { pattern: /^gpt-4\.1(?:[.-]|$)/u, contextWindowTokens: 1_047_576 },
  { pattern: /^(?:o3|o4)(?:[.-]|$)/u, contextWindowTokens: 200_000 },
  { pattern: /^gpt-4o(?:[.-]|$)/u, contextWindowTokens: 128_000 },
];

const ANTHROPIC_MODELS: readonly KnownModel[] = [
  { pattern: /^claude-(?:opus|sonnet|haiku)-4(?:[.-]|$)/u, contextWindowTokens: 200_000 },
  { pattern: /^claude-3(?:[.-]|$)/u, contextWindowTokens: 200_000 },
];

export const knownContextWindowTokens = (
  providerFamily: ModelProviderFamily,
  modelId: string,
): number | undefined =>
  (providerFamily === 'openai' ? OPENAI_MODELS : ANTHROPIC_MODELS)
    .find((entry) => entry.pattern.test(modelId))
    ?.contextWindowTokens;

export const isOfficialProviderEndpoint = (
  providerFamily: ModelProviderFamily,
  baseUrl: string,
): boolean => {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return providerFamily === 'openai'
      ? hostname === 'api.openai.com'
      : hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
};

export const supportsNativeCompaction = (
  providerFamily: ModelProviderFamily,
  wireApi: ModelWireApi,
  baseUrl: string,
): boolean =>
  isOfficialProviderEndpoint(providerFamily, baseUrl) &&
  (wireApi === 'openaiResponses' || wireApi === 'anthropicMessages');
