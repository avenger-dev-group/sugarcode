import { useEffect, useMemo, useState } from 'react';

import { codeLanguageForPath } from '@/renderer/utils/code-language';
import { highlightCode } from '@/renderer/utils/syntax-highlighter';
import type { WorkspaceInspectDocument } from '@/shared/workspace';

export const FileInspector = ({
  document,
}: Readonly<{ document: WorkspaceInspectDocument | null }>) => {
  const language = codeLanguageForPath(document?.path ?? '');
  const [highlight, setHighlight] = useState<Readonly<{
    source: string;
    value: string | null;
  }> | null>(null);
  useEffect(() => {
    setHighlight(null);
    if (!document || document.status === 'error') {
      return;
    }
    let active = true;
    const renderHighlight = (): void => {
      const result = highlightCode(document.content, language.highlight);
      if (active) {
        setHighlight({ source: document.content, value: result });
      }
    };
    const idleId = window.requestIdleCallback?.(renderHighlight, {
      timeout: 250,
    });
    const timerId = idleId === undefined
      ? window.setTimeout(renderHighlight, 0)
      : undefined;
    return () => {
      active = false;
      if (idleId !== undefined) {
        window.cancelIdleCallback?.(idleId);
      }
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [document, language.highlight]);
  const highlightedCode =
    document &&
    document.status !== 'error' &&
    highlight?.source === document.content
      ? highlight.value
      : null;
  const lineNumbers = useMemo(() => {
    if (!document || document.status === 'error') {
      return '';
    }
    const displayedLines = Math.max(
      1,
      (document.content.match(/\n/gu)?.length ?? 0) +
        (document.content.endsWith('\n') ? 0 : 1),
    );
    return Array.from(
      { length: displayedLines },
      (_, index) => index + 1,
    ).join('\n');
  }, [document]);
  if (!document) {
    return (
      <div className="flex min-h-40 flex-1 items-center justify-center px-6 text-center text-xs text-tertiary">
        Select a text file to inspect its bounded, read-only snapshot.
      </div>
    );
  }
  if (document.status === 'error') {
    return (
      <div className="m-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4" role="alert">
        <p className="text-sm font-medium text-destructive">File unavailable</p>
        <p className="mt-1 text-xs text-secondary">
          {document.path} · {document.kind}
        </p>
      </div>
    );
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`File inspector ${document.path}`}>
      <header className="border-b px-4 py-3">
        <p className="truncate text-sm font-medium" title={document.path}>
          {document.path}
        </p>
        <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-tertiary">
          {language.label} · {document.bytes.toLocaleString()} bytes · {document.lines.toLocaleString()} lines
          {document.hasUtf8Bom ? ' · UTF-8 BOM' : ''}
        </p>
        {document.status === 'truncated' ? (
          <p className="mt-2 text-xs text-secondary" role="status">
            Bounded preview — {document.returnedBytes.toLocaleString()} bytes shown.
          </p>
        ) : null}
      </header>
      <div className="workspace-code-scroll min-h-0 flex-1 overflow-auto bg-surface/40" tabIndex={0} aria-label="Read-only file content">
        <div className="grid min-w-max grid-cols-[auto_1fr] font-mono text-xs font-normal leading-5">
          <pre className="sticky left-0 select-none border-r bg-background/95 px-3 py-3 text-right text-tertiary" aria-hidden="true">
            {lineNumbers}
          </pre>
          <pre className="m-0 whitespace-pre px-4 py-3 text-foreground">
            {highlightedCode === null ? (
              <code>{document.content}</code>
            ) : (
              <code
                className="syntax-highlight hljs"
                dangerouslySetInnerHTML={{ __html: highlightedCode }}
              />
            )}
          </pre>
        </div>
      </div>
    </section>
  );
};
