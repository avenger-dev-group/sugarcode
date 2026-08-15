import { PREVIEW_URL_MAX_BYTES } from './preview.ts';

export type AgentPreviewIntent = Readonly<{
  url: string;
}>;

export type ParsedAgentPreviewResponse = Readonly<{
  text: string;
  intent: AgentPreviewIntent | null;
}>;

const DIRECTIVE_PREFIX = '::preview{';
const DIRECTIVE_PATTERN = /^::preview\{url="([^"\r\n]+)"\}$/u;

const hasForbiddenCodePoint = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

const isLocalPreviewUrl = (value: string): string | null => {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > PREVIEW_URL_MAX_BYTES ||
    value.includes('\\') ||
    hasForbiddenCodePoint(value)
  ) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname) ||
      parsed.port.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return null;
    }
    const port = Number(parsed.port);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
};

export const parseAgentPreviewResponse = (
  source: string,
): ParsedAgentPreviewResponse => {
  const trimmed = source.trimEnd();
  const lineStart = trimmed.lastIndexOf('\n') + 1;
  const candidate = trimmed.slice(lineStart).trim();
  if (!candidate.startsWith(DIRECTIVE_PREFIX)) {
    return { text: source, intent: null };
  }
  const text = trimmed.slice(0, lineStart).trimEnd();
  const match = DIRECTIVE_PATTERN.exec(candidate);
  const url = match?.[1] ? isLocalPreviewUrl(match[1]) : null;
  return {
    text,
    intent: url ? { url } : null,
  };
};
