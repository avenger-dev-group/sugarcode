import { lexer, type MarkedOptions, type Token } from 'marked';

const MARKDOWN_OPTIONS: MarkedOptions = {
  async: false,
  breaks: false,
  gfm: true,
  pedantic: false,
};
const MAX_INCREMENTAL_CACHE_SOURCE_CHARS = 1_000_000;
const COMPACT_TABLE_SEPARATOR_PATTERN =
  /\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|/u;
const TABLE_SEPARATOR_LINE_PATTERN =
  /^ {0,3}\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?[ \t]*$/u;
const PIPE_TABLE_LINE_PATTERN = /^ {0,3}\|/u;
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})(?:[^`~]*)$/u;

export type AgentMarkdownTokenCache = Readonly<{
  prefixSource: string;
  prefixTokens: readonly Token[];
}>;

export type AgentMarkdownTokenProjection = Readonly<{
  cache: AgentMarkdownTokenCache;
  tokens: readonly Token[];
}>;

export const normalizeCompactMarkdownTables = (source: string): string => {
  let fence: { character: '`' | '~'; length: number } | null = null;

  return source
    .split('\n')
    .map((line) => {
      const markerMatch = FENCE_LINE_PATTERN.exec(line);
      const marker = markerMatch?.[1];
      if (marker) {
        const character = marker[0] as '`' | '~';
        if (!fence) {
          fence = { character, length: marker.length };
        } else if (
          character === fence.character &&
          marker.length >= fence.length &&
          /^ {0,3}(?:`{3,}|~{3,})\s*$/u.test(line)
        ) {
          fence = null;
        }
        return line;
      }
      if (
        fence ||
        !/^ {0,3}\|/u.test(line) ||
        !COMPACT_TABLE_SEPARATOR_PATTERN.test(line)
      ) {
        return line;
      }
      return line.replace(
        /\|([ \t]+)\|/gu,
        (_boundary, whitespace: string) =>
          `|\n${whitespace.slice(1)}|`,
      );
    })
    .join('\n');
};

const normalizeTableCellEmphasis = (source: string): string => {
  const lines = source.split('\n');
  let fence: { character: '`' | '~'; length: number } | null = null;
  const eligibleTableLines = lines.map((line) => {
    const markerMatch = FENCE_LINE_PATTERN.exec(line);
    const marker = markerMatch?.[1];
    if (marker) {
      const character = marker[0] as '`' | '~';
      if (!fence) {
        fence = { character, length: marker.length };
      } else if (
        character === fence.character &&
        marker.length >= fence.length &&
        /^ {0,3}(?:`{3,}|~{3,})\s*$/u.test(line)
      ) {
        fence = null;
      }
      return false;
    }
    return !fence && PIPE_TABLE_LINE_PATTERN.test(line);
  });

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      !eligibleTableLines[index] ||
      !eligibleTableLines[index + 1] ||
      !TABLE_SEPARATOR_LINE_PATTERN.test(lines[index + 1] ?? '')
    ) {
      continue;
    }

    for (
      let rowIndex = index;
      rowIndex < lines.length && eligibleTableLines[rowIndex];
      rowIndex += 1
    ) {
      if (rowIndex === index + 1) {
        continue;
      }
      lines[rowIndex] = (lines[rowIndex] ?? '')
        .replace(
          /(\|[ \t]*)\*\*([ \t]+)(?=\S)/gu,
          '$1$2**',
        )
        .replace(
          /(\|[ \t]*\*\*)([^|\n]*?[^*\s])\*([ \t]*\|)/gu,
          '$1$2**$3',
        );
    }
  }

  return lines.join('\n');
};

const closingFenceFor = (source: string): string | null => {
  let opening: { character: '`' | '~'; length: number } | null = null;

  for (const line of source.split('\n')) {
    const fenceMatch = FENCE_LINE_PATTERN.exec(line);
    if (!fenceMatch) {
      continue;
    }
    const marker = fenceMatch[1];
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

const lex = (source: string): readonly Token[] => {
  const normalizedTables = normalizeCompactMarkdownTables(source);
  return Array.from(
    lexer(
      normalizeTableCellEmphasis(normalizedTables),
      MARKDOWN_OPTIONS,
    ),
  );
};

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
