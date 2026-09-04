import type { Token, Tokens } from 'marked';
import {
  Fragment,
  memo,
  type ReactElement,
  type ReactNode,
  useMemo,
  useRef,
} from 'react';
import { useStore as useZustandStore } from 'zustand';

import { workspaceProjectionStore } from '@/renderer/stores/workspace-projection-store';

import { AgentCodeBlock } from './code-block/code-block';
import { FileReferenceLink } from './file-reference-link';
import { KnowledgeCitation } from './knowledge-citation';
import { splitKnowledgeCitationText } from './knowledge-citation-text';
import { useOrchestrationActions } from '../orchestration/use-store';
import { createVerifiedWorkspaceFileReferenceResolver } from '../workspace/file-reference';
import {
  createAgentMarkdownFileDisplayLabels,
  toAgentMarkdownFileLink,
  toAgentMarkdownLinkLabel,
} from './agent-markdown-link';
import {
  projectAgentMarkdownTokens,
  type AgentMarkdownTokenCache,
} from './agent-markdown-parser';
import type { AgentMarkdownProps } from './types';

const FENCED_CODE_PATTERN = /^ {0,3}(?:`{3,}|~{3,})/u;

const tableAlignmentClass = (
  alignment: 'center' | 'left' | 'right' | null,
): string => {
  switch (alignment) {
    case 'center':
      return 'text-center';
    case 'right':
      return 'text-right';
    default:
      return 'text-left';
  }
};

const renderTokens = (
  tokens: readonly Token[],
  keyPrefix: string,
  openFile: (path: string) => void,
  workspaceGeneration: number,
  workspaceReady: boolean,
  resolveVerifiedFileReference: (value: string) => string | null,
  fileDisplayLabels: ReadonlyMap<string, string>,
  knowledgeCitations: ReadonlyMap<string, NonNullable<AgentMarkdownProps['knowledgeCitations']>[number]>,
  fileReferencesAreExact: boolean,
): ReactNode[] => {
  let offset = 0;
  return tokens.flatMap((token, index): ReactNode[] => {
    const key = `${keyPrefix}:${offset}:${token.type}:${index}`;
    offset += token.raw.length;
    const children = (nested: readonly Token[]): ReactNode[] =>
      renderTokens(
        nested,
        key,
        openFile,
        workspaceGeneration,
        workspaceReady,
        resolveVerifiedFileReference,
        fileDisplayLabels,
        knowledgeCitations,
        fileReferencesAreExact,
      );

    const citationText = (text: string): ReactNode[] => {
      return splitKnowledgeCitationText(text, knowledgeCitations)
        .map((segment, segmentIndex) => {
          if (segment.type === 'text') return segment.value;
          const citation = knowledgeCitations.get(segment.label);
          return citation ? (
            <KnowledgeCitation
              key={`${key}:citation:${segment.label}:${segmentIndex}`}
              citation={citation}
            />
          ) : `[${segment.label}]`;
        });
    };

    switch (token.type) {
      case 'space':
      case 'def':
      case 'html':
        return [];
      case 'heading': {
        const content = children(token.tokens);
        const headingClasses = {
          1: 'text-2xl leading-tight',
          2: 'text-xl leading-tight',
          3: 'text-[17px] leading-[22px]',
          4: 'text-[17px] leading-[22px]',
          5: 'text-[15px] leading-5',
          6: 'text-[15px] leading-5',
        } as const;
        const className = `${headingClasses[token.depth as keyof typeof headingClasses] ?? headingClasses[6]} mt-5 mb-2.5 font-medium first:mt-0`;
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
            className="mb-[11px] break-words text-sm leading-[22px] last:mb-0"
          >
            {children(token.tokens)}
          </p>,
        ];
      case 'blockquote':
        return [
          <blockquote
            key={key}
            className="relative mb-2 py-2 pl-6 leading-6 last:mb-0 before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-border"
          >
            {children(token.tokens)}
          </blockquote>,
        ];
      case 'list': {
        const list = token as Tokens.List;
        const hasTasks = list.items.some((item) => item.task);
        const items = list.items.map((item, itemIndex) => {
          const taskControl = item.task ? (
            <input
              aria-label={item.checked ? 'Completed task' : 'Incomplete task'}
              checked={item.checked === true}
              className="mt-0.5 size-4 shrink-0 accent-primary disabled:opacity-100"
              disabled
              readOnly
              type="checkbox"
            />
          ) : null;
          return (
            <li
              key={`${key}:item:${itemIndex}`}
              className={
                item.task
                  ? 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-1.5'
                  : 'pl-0.5'
              }
            >
              {taskControl}
              <div className={item.task ? 'min-w-0' : undefined}>
                {children(item.tokens)}
              </div>
            </li>
          );
        });
        const className =
          'mb-2.5 space-y-2 text-sm leading-[22px] last:mb-0 [&_ol]:mt-2 [&_ol]:mb-0 [&_ul]:mt-2 [&_ul]:mb-0';
        return list.ordered
          ? [
              <ol
                key={key}
                className={`${className} ${hasTasks ? 'list-none pl-0' : 'list-decimal pl-[21px]'}`}
                start={typeof list.start === 'number' ? list.start : undefined}
              >
                {items}
              </ol>,
            ]
          : [
              <ul
                key={key}
                className={`${className} ${hasTasks ? 'list-none pl-0' : 'list-disc pl-[21px] [&_ul]:list-[circle] [&_ul_ul]:list-[square]'}`}
              >
                {items}
              </ul>,
            ];
      }
      case 'code': {
        return [
          <AgentCodeBlock
            key={key}
            code={token.text}
            language={FENCED_CODE_PATTERN.test(token.raw) ? token.lang : undefined}
          />,
        ];
      }
      case 'hr':
        return [<hr key={key} className="my-7 border-border" />];
      case 'table': {
        const table = token as Tokens.Table;
        const columnCount = table.header.length;
        const useFixedLayout = columnCount >= 4;
        const useCompactCells = columnCount >= 6;
        const cellSpacing = useCompactCells ? 'px-2 py-2' : 'px-3 py-2.5';
        return [
          <div
            key={key}
            className="agent-markdown-table-shell mb-2.5 max-w-full last:mb-0"
          >
            <table
              className={`agent-markdown-table w-full max-w-full border-separate border-spacing-0 text-left ${
                useCompactCells
                  ? 'text-xs leading-5'
                  : 'text-sm leading-[22px]'
              } ${useFixedLayout ? 'table-fixed' : 'table-auto'}`}
              data-stack-on-narrow={useFixedLayout ? 'true' : undefined}
            >
              <thead>
                <tr>
                  {table.header.map((cell, cellIndex) => (
                    <th
                      key={`${key}:header:${cellIndex}`}
                      scope="col"
                      className={`min-w-0 border-b border-border align-bottom font-semibold leading-5 whitespace-normal [overflow-wrap:anywhere] first:pl-0 last:pr-0 ${cellSpacing} ${tableAlignmentClass(cell.align)}`}
                    >
                      {children(cell.tokens)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr
                    key={`${key}:row:${rowIndex}`}
                    className="align-top [&:not(:last-child)>td]:border-b [&:not(:last-child)>td]:border-border"
                  >
                    {row.map((cell, cellIndex) => (
                      <td
                        key={`${key}:row:${rowIndex}:cell:${cellIndex}`}
                        data-label={
                          table.header[cellIndex]?.text ??
                          `第 ${cellIndex + 1} 列`
                        }
                        className={`agent-markdown-table-cell min-w-0 align-top whitespace-normal [overflow-wrap:anywhere] first:pl-0 last:pr-0 ${cellSpacing} ${tableAlignmentClass(cell.align)}`}
                      >
                        <span className="agent-markdown-table-value block min-w-0">
                          {children(cell.tokens)}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        ];
      }
      case 'strong':
        return [
          <strong key={key} className="font-medium">
            {children(token.tokens)}
          </strong>,
        ];
      case 'em':
        return [<em key={key}>{children(token.tokens)}</em>];
      case 'codespan':
        {
          const path = resolveVerifiedFileReference(token.text);
          if (path) {
            return [
              <FileReferenceLink
                exactPath
                key={key}
                openFile={openFile}
                path={path}
                variant="code"
                workspaceGeneration={workspaceGeneration}
                workspaceReady={workspaceReady}
              >
                {fileDisplayLabels.get(path) ?? token.text}
              </FileReferenceLink>,
            ];
          }
        }
        return [
          <code
            key={key}
            className="break-words rounded-md bg-surface px-1.5 py-px font-mono text-[0.92em] font-normal"
          >
            {token.text}
          </code>,
        ];
      case 'br':
        return [<br key={key} />];
      case 'link':
        {
          const fileLink = toAgentMarkdownFileLink(
            token.href,
            token.tokens,
            token.text,
            fileDisplayLabels,
          );
          if (fileLink) {
            return [
              <FileReferenceLink
                exactPath={fileReferencesAreExact}
                key={key}
                openFile={openFile}
                path={fileLink.path}
                variant="link"
                workspaceGeneration={workspaceGeneration}
                workspaceReady={workspaceReady}
              >
                {fileLink.label}
              </FileReferenceLink>,
            ];
          }
        }
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
            {toAgentMarkdownLinkLabel(token.tokens, token.text)}
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
            {token.tokens ? children(token.tokens) : citationText(token.text)}
          </Fragment>,
        ];
      case 'escape':
        return [<Fragment key={key}>{token.text}</Fragment>];
      case 'del':
        return [
          <del key={key} className="decoration-secondary">
            {children(token.tokens)}
          </del>,
        ];
      case 'checkbox':
      case 'list_item':
        return [];
      default:
        return [
          <Fragment key={key}>{token.raw}</Fragment>,
        ];
    }
  });
};

const AgentMarkdownView = ({
  source,
  isStreaming,
  verifiedFilePaths = [],
  knowledgeCitations = [],
  onOpenFile,
}: AgentMarkdownProps): ReactElement => {
  const { openFile: openWorkspaceFile } = useOrchestrationActions();
  const openFile = onOpenFile ?? openWorkspaceFile;
  const workspaceGeneration = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.snapshot.generation,
  );
  const workspaceReady = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.snapshot.status === 'ready',
  );
  const cache = useRef<AgentMarkdownTokenCache | undefined>(undefined);
  const resolveVerifiedFileReference = useMemo(
    () => createVerifiedWorkspaceFileReferenceResolver(verifiedFilePaths),
    [verifiedFilePaths],
  );
  const projection = useMemo(() => {
    const next = projectAgentMarkdownTokens(
      source,
      isStreaming,
      cache.current,
    );
    cache.current = next.cache;
    return next;
  }, [isStreaming, source]);
  const fileDisplayLabels = useMemo(
    () =>
      createAgentMarkdownFileDisplayLabels(
        projection.tokens,
        resolveVerifiedFileReference,
      ),
    [projection.tokens, resolveVerifiedFileReference],
  );
  const citationByLabel = useMemo(() => {
    const result = new Map<string, (typeof knowledgeCitations)[number]>();
    for (const citation of knowledgeCitations) {
      result.set(citation.citation, citation);
    }
    return result;
  }, [knowledgeCitations]);

  return (
    <div className="min-w-0 max-w-full break-words font-normal text-foreground">
      {renderTokens(
        projection.tokens,
        'root',
        openFile,
        workspaceGeneration,
        workspaceReady,
        resolveVerifiedFileReference,
        fileDisplayLabels,
        citationByLabel,
        onOpenFile !== undefined,
      )}
    </div>
  );
};

export const AgentMarkdown = memo(AgentMarkdownView);
