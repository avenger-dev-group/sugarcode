import type {
  ModelProviderFamily,
  ModelWireApi,
} from '@/shared/model-config';

export type ProviderPreset = Readonly<{
  providerFamily: ModelProviderFamily;
  label: string;
  baseUrl: string;
  wireApi: ModelWireApi;
}>;

export const DEFAULT_NEW_MODEL_WIRE_API: ModelWireApi = 'openaiResponses';

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    providerFamily: 'openai',
    label: 'OpenAI Responses',
    baseUrl: 'https://api.openai.com/v1',
    wireApi: 'openaiResponses',
  },
  {
    providerFamily: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    wireApi: 'anthropicMessages',
  },
  {
    providerFamily: 'openai',
    label: 'OpenAI-compatible',
    baseUrl: 'https://api.openai.com/v1',
    wireApi: 'openaiChatCompletions',
  },
];

export const presetForWire = (wireApi: ModelWireApi): ProviderPreset =>
  PROVIDER_PRESETS.find(
    (preset) => preset.wireApi === wireApi,
  ) ?? PROVIDER_PRESETS[0];

export const baseUrlForProviderWireChange = (
  currentWireApi: ModelWireApi,
  currentBaseUrl: string,
  nextWireApi: ModelWireApi,
): string =>
  currentBaseUrl === presetForWire(currentWireApi).baseUrl
    ? presetForWire(nextWireApi).baseUrl
    : currentBaseUrl;
