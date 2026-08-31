import { FunctionTool } from '@google/adk';
import { Type, type Schema } from '@google/genai';

export const SUBMIT_FINAL_RESPONSE_TOOL_NAME = 'submit_final_response';
export const MAX_FINAL_RESPONSE_BYTES = 64 * 1024;

const FINAL_RESPONSE_OPEN_TAG = '<final_response>';
const FINAL_RESPONSE_CLOSE_TAG = '</final_response>';
const REASONING_CLOSE_TAG = '</think>';

const withoutPartialClosingTag = (value: string, tag: string): string => {
  const maximum = Math.min(value.length, tag.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(tag.slice(0, length))) {
      return value.slice(0, -length);
    }
  }
  return value;
};

const SUBMIT_FINAL_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    content: {
      type: Type.STRING,
      description:
        'The complete user-facing response, in the language appropriate for the user. Do not include private reasoning, drafting notes, or instructions to the model.',
    },
  },
  required: ['content'],
} satisfies Schema;

export type FinalResponseSubmissionGuard = {
  content?: string;
};

type FinalResponseSubmissionOptions = Readonly<{
  guard: FinalResponseSubmissionGuard;
  validate: (content: string) => string | undefined | Promise<string | undefined>;
}>;

const responseContent = (input: unknown): string => {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    !('content' in input) ||
    typeof input.content !== 'string'
  ) {
    return '';
  }
  return input.content.trim();
};

export const extractDelimitedFinalResponse = (
  value: string,
): string | undefined => {
  const explicitStart = value.lastIndexOf(FINAL_RESPONSE_OPEN_TAG);
  if (explicitStart >= 0) {
    const contentStart = explicitStart + FINAL_RESPONSE_OPEN_TAG.length;
    const explicitEnd = value.indexOf(
      FINAL_RESPONSE_CLOSE_TAG,
      contentStart,
    );
    if (
      explicitEnd >= contentStart &&
      value.slice(explicitEnd + FINAL_RESPONSE_CLOSE_TAG.length).trim()
        .length === 0
    ) {
      const content = value.slice(contentStart, explicitEnd).trim();
      return content.length > 0 ? content : undefined;
    }
  }

  const reasoningEnd = value.lastIndexOf(REASONING_CLOSE_TAG);
  if (reasoningEnd < 0) return undefined;
  const content = value.slice(reasoningEnd + REASONING_CLOSE_TAG.length).trim();
  return content.length > 0 ? content : undefined;
};

export const streamableDelimitedFinalResponse = (
  value: string,
): string | undefined => {
  const explicitStart = value.lastIndexOf(FINAL_RESPONSE_OPEN_TAG);
  if (explicitStart >= 0) {
    const contentStart = explicitStart + FINAL_RESPONSE_OPEN_TAG.length;
    const explicitEnd = value.indexOf(
      FINAL_RESPONSE_CLOSE_TAG,
      contentStart,
    );
    if (explicitEnd >= contentStart) {
      return value.slice(contentStart, explicitEnd);
    }
    return withoutPartialClosingTag(
      value.slice(contentStart),
      FINAL_RESPONSE_CLOSE_TAG,
    );
  }

  const reasoningEnd = value.lastIndexOf(REASONING_CLOSE_TAG);
  return reasoningEnd < 0
    ? undefined
    : value.slice(reasoningEnd + REASONING_CLOSE_TAG.length);
};

export const createSubmitFinalResponseTool = (
  options: FinalResponseSubmissionOptions,
): FunctionTool<Schema> =>
  new FunctionTool({
    name: SUBMIT_FINAL_RESPONSE_TOOL_NAME,
    description:
      'Submit the one complete response that the user may see. Ordinary assistant text is private working text and is not displayed. Call this exactly once after all work, tool calls, user-input requests, and child-agent results are complete. Put only the self-contained user-facing answer in content, with no analysis, drafting notes, model instructions, or tool narration. Do not repeat the answer after this call succeeds.',
    parameters: SUBMIT_FINAL_RESPONSE_SCHEMA,
    execute: async (input) => {
      const content = responseContent(input);
      if (content.length === 0) {
        return {
          ok: false,
          error: {
            kind: 'invalidFinalResponse',
            message: 'The submitted final response must not be empty.',
          },
        };
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_FINAL_RESPONSE_BYTES) {
        return {
          ok: false,
          error: {
            kind: 'invalidFinalResponse',
            message: `The submitted final response exceeds the ${MAX_FINAL_RESPONSE_BYTES}-byte limit. Make it concise and submit the complete response again.`,
          },
        };
      }
      const issue = await options.validate(content);
      if (issue) {
        return {
          ok: false,
          error: { kind: 'invalidFinalResponse', message: issue },
        };
      }
      options.guard.content = content;
      return {
        ok: true,
        message:
          'The final response was accepted and will be shown to the user. Do not repeat it.',
      };
    },
  });
