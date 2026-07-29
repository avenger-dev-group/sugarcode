import type { Token, Tokens } from 'marked';
import {
  Fragment,
  memo,
  type ReactElement,
  type ReactNode,
  useMemo,
  useRef,
} from 'react';

import {
  projectAgentMarkdownTokens,
  type AgentMarkdownTokenCache,
} from './agent-markdown-parser';
import type { AgentMarkdownProps } from './types';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const CODE_LANGUAGE_HINT_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_+.#-]{0,63}$/u;
const FENCED_CODE_PATTERN = /^ {0,3}(?:`{3,}|~{3,})/u;

const codeLanguageHint = (language: string | undefined): string | null => {
  const hint = language?.trimStart().split(/\s+/u, 1)[0];
  return hint && CODE_LANGUAGE_HINT_PATTERN.test(hint) ? hint : null;
};

const codeFenceLineCount = (text: string): number => {
  if (text.length === 0) {
    return 0;
  }
  let lines = 1;
  for (const character of text) {
    if (character === '\n') {
      lines += 1;
    }
  }
  return lines;
};

const codeFenceLineLabel = (lines: number): string =>
  `${lines} ${lines === 1 ? 'line' : 'lines'}`;

const renderText = (
  text: string,
  keyPrefix: string,
  isStreaming: boolean,
): ReactNode => {
  if (!isStreaming) {
    return text;
  }
  let offset = 0;
  return Array.from(segmenter.segment(text), (segment) => {
    const key = `${keyPrefix}:${offset}`;
    offset += segment.segment.length;
    return (
      <span
        key={key}
        className={isStreaming ? 'agent-markdown-segment' : undefined}
      >
        {segment.segment}
      </span>
    );
  });
};

const renderTokens = (
  tokens: readonly Token[],
  keyPrefix: string,
  isStreaming: boolean,
): ReactNode[] => {
  let offset = 0;
  return tokens.flatMap((token, index): ReactNode[] => {
    const key = `${keyPrefix}:${offset}:${token.type}:${index}`;
    offset += token.raw.length;
    const children = (nested: readonly Token[]): ReactNode[] =>
      renderTokens(nested, key, isStreaming);

    switch (token.type) {
      case 'space':
      case 'def':
      case 'html':
        return [];
      case 'heading': {
        const content = children(token.tokens);
        const headingClasses = {
          1: 'mt-5 text-lg leading-[1.35] tracking-[-0.02em]',
          2: 'mt-5 text-base leading-[1.4] tracking-[-0.01em]',
          3: 'mt-4 text-sm leading-[22px]',
          4: 'mt-4 text-sm leading-[22px]',
          5: 'mt-4 text-sm leading-[22px]',
          6: 'mt-4 text-sm leading-[22px] text-secondary',
        } as const;
        const className = `${headingClasses[token.depth as keyof typeof headingClasses] ?? headingClasses[6]} font-medium first:mt-0`;
        switch (token.depth) {
          case 1:
            return [
              <h1 key={key} className={className}>
                {content}
              </h1>,
            ];
          case 2:
            return [
              <h2 key={key} className={className}>
                {content}
              </h2>,
            ];
          case 3:
            return [
              <h3 key={key} className={className}>
                {content}
              </h3>,
            ];
          case 4:
            return [
              <h4 key={key} className={className}>
                {content}
              </h4>,
            ];
          case 5:
            return [
              <h5 key={key} className={className}>
                {content}
              </h5>,
            ];
          default:
            return [
              <h6 key={key} className={className}>
                {content}
              </h6>,
            ];
        }
      }
      case 'paragraph':
        return [
          <p
            key={key}
            className="mt-3 break-words text-sm font-normal leading-[22px] first:mt-0"
          >
            {children(token.tokens)}
          </p>,
        ];
      case 'blockquote':
        return [
          <blockquote
            key={key}
            className="mt-3 border-l-2 pl-3 text-secondary first:mt-0"
          >
            {children(token.tokens)}
          </blockquote>,
        ];
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item, itemIndex) => (
          <li key={`${key}:item:${itemIndex}`} className="pl-1">
            {children(item.tokens)}
          </li>
        ));
        const className =
          'mt-3 ml-5 space-y-1 text-sm font-normal leading-[22px] first:mt-0';
        return list.ordered
          ? [
              <ol
                key={key}
                className={`${className} list-decimal`}
                start={typeof list.start === 'number' ? list.start : undefined}
              >
                {items}
              </ol>,
            ]
          : [
              <ul key={key} className={`${className} list-disc`}>
                {items}
              </ul>,
            ];
      }
      case 'code': {
        if (!FENCED_CODE_PATTERN.test(token.raw)) {
          return [
            <pre
              key={key}
              className="mt-3 max-w-full overflow-x-auto rounded-xl border bg-surface p-3 font-mono text-xs font-normal leading-normal first:mt-0"
            >
              <code>{token.text}</code>
            </pre>,
          ];
        }
        const languageHint = codeLanguageHint(token.lang);
        const lineLabel = codeFenceLineLabel(
          codeFenceLineCount(token.text),
        );
        const captionLabel = languageHint
          ? `Language hint ${languageHint}, ${lineLabel}`
          : `Code fence, ${lineLabel}`;
        const captionId = `${key}:code-fence-caption`;
        return [
          <figure
            key={key}
            aria-labelledby={captionId}
            className="mt-3 min-w-0 max-w-full overflow-hidden rounded-xl border bg-surface first:mt-0"
          >
            <figcaption
              id={captionId}
              aria-label={captionLabel}
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b px-3 py-2 font-mono text-[10px] text-tertiary"
            >
              <span className="uppercase tracking-[0.14em]">
                {languageHint ? 'Language hint' : 'Code fence'}
              </span>
              {languageHint ? (
                <span className="min-w-0 break-all tracking-[0.08em]">
                  {languageHint}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 whitespace-nowrap tracking-[0.08em]">
                {lineLabel}
              </span>
            </figcaption>
            <pre className="max-w-full overflow-x-auto p-3 font-mono text-xs font-normal leading-normal">
              <code>{token.text}</code>
            </pre>
          </figure>,
        ];
      }
      case 'hr':
        return [<hr key={key} className="my-5 border-border" />];
      case 'strong':
        return [
          <strong key={key} className="font-bold">
            {children(token.tokens)}
          </strong>,
        ];
      case 'em':
        return [<em key={key}>{children(token.tokens)}</em>];
      case 'codespan':
        return [
          <code
            key={key}
            className="break-words rounded bg-surface px-1 py-0.5 font-mono text-xs font-normal"
          >
            {token.text}
          </code>,
        ];
      case 'br':
        return [<br key={key} />];
      case 'link':
        return [
          <span
            key={key}
            className="text-secondary underline decoration-border underline-offset-2"
            role="link"
            aria-disabled="true"
            aria-label={
              token.href
                ? `Link unavailable: ${token.href}`
                : 'Link unavailable'
            }
          >
            {children(token.tokens)}
          </span>,
        ];
      case 'image':
        return [
          <span
            key={key}
            className="inline-flex rounded border bg-surface px-2 py-1 font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-tertiary"
            role="img"
            aria-label={
              token.text ? `Image omitted: ${token.text}` : 'Image omitted'
            }
          >
            {token.text ? `Image: ${token.text}` : 'Image omitted'}
          </span>,
        ];
      case 'text':
        return [
          <Fragment key={key}>
            {token.tokens
              ? children(token.tokens)
              : renderText(token.text, key, isStreaming)}
          </Fragment>,
        ];
      case 'escape':
        return [
          <Fragment key={key}>
            {renderText(token.text, key, isStreaming)}
          </Fragment>,
        ];
      case 'del':
        return [<Fragment key={key}>{children(token.tokens)}</Fragment>];
      case 'table':
      case 'checkbox':
      case 'list_item':
        return [];
      default:
        return [
          <Fragment key={key}>
            {renderText(token.raw, key, isStreaming)}
          </Fragment>,
        ];
    }
  });
};

const AgentMarkdownView = ({
  source,
  isStreaming,
}: AgentMarkdownProps): ReactElement => {
  const cache = useRef<AgentMarkdownTokenCache | undefined>(undefined);
  const projection = useMemo(() => {
    const next = projectAgentMarkdownTokens(
      source,
      isStreaming,
      cache.current,
    );
    cache.current = next.cache;
    return next;
  }, [isStreaming, source]);

  return (
    <div className="min-w-0 max-w-full text-foreground">
      {renderTokens(projection.tokens, 'root', isStreaming)}
    </div>
  );
};

export const AgentMarkdown = memo(AgentMarkdownView);
