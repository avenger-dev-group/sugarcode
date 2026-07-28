import { lexer, type MarkedOptions, type Token } from 'marked';

const MARKDOWN_OPTIONS: MarkedOptions = {
  async: false,
  breaks: false,
  gfm: false,
  pedantic: false,
};
const MAX_INCREMENTAL_CACHE_SOURCE_CHARS = 1_000_000;

export type AgentMarkdownTokenCache = Readonly<{
  prefixSource: string;
  prefixTokens: readonly Token[];
}>;

export type AgentMarkdownTokenProjection = Readonly<{
  cache: AgentMarkdownTokenCache;
  tokens: readonly Token[];
}>;

const closingFenceFor = (source: string): string | null => {
  let opening: { character: '`' | '~'; length: number } | null = null;

  for (const line of source.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})(?:[^`~]*)$/.exec(line);
    if (!fence) {
      continue;
    }
    const marker = fence[1];
    if (!marker) {
      continue;
    }
    const character = marker[0] as '`' | '~';
    if (!opening) {
      opening = { character, length: marker.length };
      continue;
    }
    if (
      character === opening.character &&
      marker.length >= opening.length &&
      /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line)
    ) {
      opening = null;
    }
  }

  return opening ? opening.character.repeat(opening.length) : null;
};

const closeIncompleteLink = (source: string): string => {
  const lastLineStart = source.lastIndexOf('\n') + 1;
  const lastLine = source.slice(lastLineStart);
  const opening = /!?\[[^\]\n]*\]\([^\n)]*$/.exec(lastLine);
  return opening ? `${source})` : source;
};

const closeIncompleteEmphasis = (source: string): string => {
  const lastLineStart = source.lastIndexOf('\n') + 1;
  const lastLine = source.slice(lastLineStart);
  const unescaped = lastLine.replace(/\\./g, '');
  const strongCount = (unescaped.match(/\*\*/g) ?? []).length;
  if (strongCount % 2 === 1) {
    return `${source}**`;
  }

  const withoutStrong = unescaped.replace(/\*\*/g, '');
  const emphasisMarkers = [...withoutStrong.matchAll(/\*/g)];
  const lastMarker = emphasisMarkers.at(-1);
  if (
    emphasisMarkers.length % 2 === 1 &&
    lastMarker &&
    !/^\s*$/.test(withoutStrong.slice(lastMarker.index + 1))
  ) {
    return `${source}*`;
  }
  return source;
};

export const repairStreamingMarkdown = (source: string): string => {
  const closingFence = closingFenceFor(source);
  if (closingFence) {
    return `${source}${source.endsWith('\n') ? '' : '\n'}${closingFence}`;
  }
  return closeIncompleteEmphasis(closeIncompleteLink(source));
};

const lex = (source: string): readonly Token[] =>
  Array.from(lexer(source, MARKDOWN_OPTIONS));

const sourceLength = (tokens: readonly Token[]): number =>
  tokens.reduce((length, token) => length + token.raw.length, 0);

const nextCache = (
  source: string,
  tokens: readonly Token[],
): AgentMarkdownTokenCache => {
  if (source.length > MAX_INCREMENTAL_CACHE_SOURCE_CHARS) {
    return { prefixSource: '', prefixTokens: [] };
  }
  let lastContentIndex = -1;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.type !== 'space') {
      lastContentIndex = index;
      break;
    }
  }
  if (lastContentIndex <= 0) {
    return { prefixSource: '', prefixTokens: [] };
  }

  const prefixTokens = tokens.slice(0, lastContentIndex);
  const prefixLength = sourceLength(prefixTokens);
  if (prefixLength > source.length) {
    return { prefixSource: '', prefixTokens: [] };
  }
  return {
    prefixSource: source.slice(0, prefixLength),
    prefixTokens,
  };
};

export const projectAgentMarkdownTokens = (
  source: string,
  isStreaming: boolean,
  previous?: AgentMarkdownTokenCache,
): AgentMarkdownTokenProjection => {
  const canReusePrefix =
    previous !== undefined && source.startsWith(previous.prefixSource);
  const prefixSource = canReusePrefix ? previous.prefixSource : '';
  const prefixTokens = canReusePrefix ? previous.prefixTokens : [];
  const tailSource = source.slice(prefixSource.length);
  const displayTail = isStreaming
    ? repairStreamingMarkdown(tailSource)
    : tailSource;
  const tokens = [...prefixTokens, ...lex(displayTail)];

  return {
    cache: nextCache(source, tokens),
    tokens,
  };
};
