import { PREVIEW_URL_MAX_BYTES } from './preview.ts';

export type AgentPreviewIntent =
  | Readonly<{
      kind: 'artifact';
      path: string;
    }>
  | Readonly<{
      kind: 'drawio';
      path: string;
    }>
  | Readonly<{
      kind: 'url';
      url: string;
    }>;

export type ParsedAgentPreviewResponse = Readonly<{
  text: string;
  intent: AgentPreviewIntent | null;
}>;

const PREVIEW_DIRECTIVE_PREFIX = '::preview{';
const DRAW_DIRECTIVE_PREFIX = '::draw{';
const URL_DIRECTIVE_PATTERN = /^::preview\{url="([^"\r\n]+)"\}$/u;
const PATH_DIRECTIVE_PATTERN = /^::preview\{path="([^"\r\n]+)"\}$/u;
const DRAW_PATH_DIRECTIVE_PATTERN = /^::draw\{path="([^"\r\n]+)"\}$/u;

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

const isHtmlArtifactPath = (value: string): string | null => {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 1_024 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[a-z]:[\\/]/iu.test(value) ||
    hasForbiddenCodePoint(value)
  ) {
    return null;
  }
  const parts = value.split(/[\\/]/u);
  if (
    parts.length > 64 ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..') ||
    !/\.html?$/iu.test(parts.at(-1) ?? '')
  ) {
    return null;
  }
  return parts.join('/');
};

const isDrawioArtifactPath = (value: string): string | null => {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 1_024 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[a-z]:[\\/]/iu.test(value) ||
    hasForbiddenCodePoint(value)
  ) {
    return null;
  }
  const parts = value.split(/[\\/]/u);
  if (
    parts.length > 64 ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..') ||
    !/\.drawio$/iu.test(parts.at(-1) ?? '')
  ) {
    return null;
  }
  return parts.join('/');
};

export const parseAgentPreviewResponse = (
  source: string,
): ParsedAgentPreviewResponse => {
  const trimmed = source.trimEnd();
  const lineStart = trimmed.lastIndexOf('\n') + 1;
  const candidate = trimmed.slice(lineStart).trim();
  if (
    !candidate.startsWith(PREVIEW_DIRECTIVE_PREFIX) &&
    !candidate.startsWith(DRAW_DIRECTIVE_PREFIX)
  ) {
    return { text: source, intent: null };
  }
  const text = trimmed.slice(0, lineStart).trimEnd();
  const drawPathMatch = DRAW_PATH_DIRECTIVE_PATTERN.exec(candidate);
  const drawioPath = drawPathMatch?.[1]
    ? isDrawioArtifactPath(drawPathMatch[1])
    : null;
  const pathMatch = PATH_DIRECTIVE_PATTERN.exec(candidate);
  const artifactPath = pathMatch?.[1]
    ? isHtmlArtifactPath(pathMatch[1])
    : null;
  const urlMatch = URL_DIRECTIVE_PATTERN.exec(candidate);
  const url = urlMatch?.[1] ? isLocalPreviewUrl(urlMatch[1]) : null;
  return {
    text,
    intent: drawioPath
      ? { kind: 'drawio', path: drawioPath }
      : artifactPath
      ? { kind: 'artifact', path: artifactPath }
      : url
        ? { kind: 'url', url }
        : null,
  };
};
