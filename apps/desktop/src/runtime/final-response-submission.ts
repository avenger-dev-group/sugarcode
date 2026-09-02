import { FunctionTool } from '@google/adk';
import { Type, type Schema } from '@google/genai';

export const SUBMIT_FINAL_RESPONSE_TOOL_NAME = 'submit_final_response';
export const MAX_FINAL_RESPONSE_BYTES = 64 * 1024;

const FINAL_RESPONSE_OPEN_TAG = '<final_response>';
const FINAL_RESPONSE_CLOSE_TAG = '</final_response>';
const REASONING_CLOSE_TAG = '</think>';

const JSON_STRING_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

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

/**
 * Decodes the complete prefix of the `content` JSON string while tool-call
 * arguments are still arriving. An unfinished escape sequence is withheld
 * until the next chunk so the renderer never receives broken JSON syntax.
 */
export const streamableFinalResponseToolContent = (
  value: string,
): string | undefined => {
  const match = /"content"\s*:\s*"/u.exec(value);
  if (!match || match.index === undefined) return undefined;
  let cursor = match.index + match[0].length;
  let result = '';
  while (cursor < value.length) {
    const character = value[cursor];
    if (character === '"') {
      return result;
    }
    if (character !== '\\') {
      if (character.charCodeAt(0) <= 0x1f) return undefined;
      result += character;
      cursor += 1;
      continue;
    }
    const escape = value[cursor + 1];
    if (escape === undefined) break;
    if (escape === 'u') {
      const hex = value.slice(cursor + 2, cursor + 6);
      if (hex.length < 4) break;
      if (!/^[0-9a-f]{4}$/iu.test(hex)) return undefined;
      const codeUnit = Number.parseInt(hex, 16);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const lowEscape = value.slice(cursor + 6, cursor + 12);
        if (lowEscape.length < 6) break;
        if (/^\\u[0-9a-f]{4}$/iu.test(lowEscape)) {
          const lowCodeUnit = Number.parseInt(lowEscape.slice(2), 16);
          if (lowCodeUnit >= 0xdc00 && lowCodeUnit <= 0xdfff) {
            result += String.fromCodePoint(
              0x10000 +
                ((codeUnit - 0xd800) << 10) +
                (lowCodeUnit - 0xdc00),
            );
            cursor += 12;
            continue;
          }
        }
      }
      result += String.fromCharCode(codeUnit);
      cursor += 6;
      continue;
    }
    const decoded = JSON_STRING_ESCAPES[escape];
    if (decoded === undefined) return undefined;
    result += decoded;
    cursor += 2;
  }
  return result;
};

export const createSubmitFinalResponseTool = (
  options: FinalResponseSubmissionOptions,
): FunctionTool<Schema> =>
  new FunctionTool({
    name: SUBMIT_FINAL_RESPONSE_TOOL_NAME,
    description:
      'Optionally submit one complete user-facing response when an explicit boundary from private work is useful. Ordinary assistant text can also complete the Turn. If you call this tool, do so exactly once after all work, tool calls, user-input requests, and child-agent results are complete. Put only the self-contained answer in content and do not repeat it after this call succeeds.',
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
