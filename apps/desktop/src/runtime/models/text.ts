import { type BaseLlm, type LlmRequest } from '@google/adk';

export const generateFinalModelText = async (
  model: BaseLlm,
  request: LlmRequest,
  signal: AbortSignal,
): Promise<string> => {
  let streamed = '';
  let terminal = '';
  for await (const response of model.generateContentAsync(request, true, signal)) {
    const text = (response.content?.parts ?? [])
      .filter((part) => part.thought !== true && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('');
    if (response.partial === false) {
      terminal = text;
    } else if (response.partial === true) {
      streamed += text;
    }
  }
  const result = (terminal || streamed).trim();
  if (!result) {
    throw new Error('The media analysis model returned no text.');
  }
  return result;
};
