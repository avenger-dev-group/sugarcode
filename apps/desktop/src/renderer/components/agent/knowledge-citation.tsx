import { ExternalLink, FolderSearch, LoaderCircle } from 'lucide-react';
import { useState } from 'react';

import {
  openKnowledgeDocument,
  revealKnowledgeDocument,
} from '@/renderer/services/knowledge';
import type { ConversationKnowledgeCitation } from '@/shared/conversation';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../ui/popover';

const locationLabel = (citation: ConversationKnowledgeCitation): string => {
  const parts: string[] = [];
  if (citation.heading) parts.push(citation.heading);
  if (citation.pageNumber) parts.push(`第 ${citation.pageNumber} 页`);
  if (citation.startLine) {
    parts.push(
      citation.endLine && citation.endLine !== citation.startLine
        ? `第 ${citation.startLine}–${citation.endLine} 行`
        : `第 ${citation.startLine} 行`,
    );
  }
  return parts.join(' · ');
};

export const KnowledgeCitation = ({
  citation,
}: Readonly<{ citation: ConversationKnowledgeCitation }>) => {
  const [pending, setPending] = useState<'open' | 'reveal' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const location = locationLabel(citation);
  const run = async (action: 'open' | 'reveal'): Promise<void> => {
    setPending(action);
    setError(null);
    try {
      const result = action === 'open'
        ? await openKnowledgeDocument(citation.knowledgeBaseId, citation.documentId)
        : await revealKnowledgeDocument(citation.knowledgeBaseId, citation.documentId);
      if (!result.accepted) {
        setError('message' in result
          ? result.message ?? '来源文件暂时不可用。'
          : '来源文件暂时不可用。');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '来源文件暂时不可用。');
    } finally {
      setPending(null);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="mx-0.5 inline-flex translate-y-[-1px] items-center rounded-md border border-primary/20 bg-primary/5 px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-primary hover:border-primary/35 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`查看引用 ${citation.citation}：${citation.fileName}`}
        >
          [{citation.citation}]
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] p-0">
        <div className="border-b px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-tertiary">
            <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono font-medium text-primary">
              [{citation.citation}]
            </span>
            <span className="truncate">{citation.knowledgeBaseName}</span>
          </div>
          <p className="mt-1.5 break-all text-sm font-medium text-foreground">
            {citation.fileName}
          </p>
          <p className="mt-0.5 break-all font-mono text-[10px] text-tertiary">
            {citation.relativePath}
          </p>
          {location ? (
            <p className="mt-1 text-xs text-secondary">{location}</p>
          ) : null}
        </div>
        <div className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11px] leading-5 text-secondary">
          {citation.content}
        </div>
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-secondary hover:bg-surface hover:text-foreground disabled:opacity-50"
            disabled={pending !== null}
            onClick={() => void run('open')}
          >
            {pending === 'open' ? (
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
            ) : (
              <ExternalLink className="size-3" aria-hidden="true" />
            )}
            打开来源
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-secondary hover:bg-surface hover:text-foreground disabled:opacity-50"
            disabled={pending !== null}
            onClick={() => void run('reveal')}
          >
            {pending === 'reveal' ? (
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
            ) : (
              <FolderSearch className="size-3" aria-hidden="true" />
            )}
            在文件管理器中显示
          </button>
        </div>
        {error ? (
          <p className="border-t px-4 py-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
};
