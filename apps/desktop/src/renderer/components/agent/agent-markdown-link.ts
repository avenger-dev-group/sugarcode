import type { Token } from 'marked';

import {
  createShortestUniquePathLabels,
  fileBasename,
} from '../../utils/file-display-name.ts';

import { toWorkspaceFileReference } from '../workspace/file-reference.ts';

const tokenText = (token: Token): string => {
  switch (token.type) {
    case 'text':
    case 'escape':
    case 'codespan':
      return token.text;
    case 'br':
      return '\n';
    case 'strong':
    case 'em':
    case 'del':
    case 'link':
      return token.tokens.map(tokenText).join('');
    default:
      return token.raw;
  }
};

export const toAgentMarkdownLinkLabel = (
  tokens: readonly Token[],
  fallback: string,
): string => {
  const label = tokens.map(tokenText).join('');
  return label || fallback;
};

export const toAgentMarkdownFileLink = (
  href: string,
  tokens: readonly Token[],
  fallback: string,
  displayLabels?: ReadonlyMap<string, string>,
): Readonly<{ path: string; label: string }> | null => {
  const path = toWorkspaceFileReference(href);
  if (!path) {
    return null;
  }
  const originalLabel = toAgentMarkdownLinkLabel(tokens, fallback);
  const labelReference = toWorkspaceFileReference(originalLabel);
  const normalizedPath = path.replaceAll('\\', '/');
  const normalizedLabel = labelReference?.replaceAll('\\', '/');
  const labelIsPath = normalizedLabel !== undefined &&
    (normalizedPath === normalizedLabel ||
      normalizedPath.endsWith(`/${normalizedLabel}`));
  return {
    path,
    label: labelIsPath
      ? displayLabels?.get(path) ?? fileBasename(path)
      : originalLabel,
  };
};

const visitFileReferences = (
  tokens: readonly Token[],
  resolveCodeSpan: (value: string) => string | null,
  paths: string[],
): void => {
  for (const token of tokens) {
    switch (token.type) {
      case 'link': {
        const path = toWorkspaceFileReference(token.href);
        if (path) {
          paths.push(path);
        }
        break;
      }
      case 'codespan': {
        const path = resolveCodeSpan(token.text);
        if (path) {
          paths.push(path);
        }
        break;
      }
      case 'heading':
      case 'paragraph':
      case 'blockquote':
      case 'strong':
      case 'em':
      case 'del':
      case 'text':
        if (token.tokens) {
          visitFileReferences(token.tokens, resolveCodeSpan, paths);
        }
        break;
      case 'list':
        for (const item of token.items) {
          visitFileReferences(item.tokens, resolveCodeSpan, paths);
        }
        break;
      case 'table':
        for (const cell of token.header) {
          visitFileReferences(cell.tokens, resolveCodeSpan, paths);
        }
        for (const row of token.rows) {
          for (const cell of row) {
            visitFileReferences(cell.tokens, resolveCodeSpan, paths);
          }
        }
        break;
      default:
        break;
    }
  }
};

export const createAgentMarkdownFileDisplayLabels = (
  tokens: readonly Token[],
  resolveCodeSpan: (value: string) => string | null,
): ReadonlyMap<string, string> => {
  const paths: string[] = [];
  visitFileReferences(tokens, resolveCodeSpan, paths);
  return createShortestUniquePathLabels(paths);
};
