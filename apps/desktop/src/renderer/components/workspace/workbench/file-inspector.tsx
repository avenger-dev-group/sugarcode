import type { WorkspaceInspectDocument } from '@/shared/workspace';

const languageForPath = (path: string): string => {
  const extension = path.split('.').pop()?.toLowerCase();
  return (
    {
      rs: 'Rust',
      ts: 'TypeScript',
      tsx: 'TypeScript React',
      js: 'JavaScript',
      jsx: 'JavaScript React',
      json: 'JSON',
      md: 'Markdown',
      toml: 'TOML',
      yaml: 'YAML',
      yml: 'YAML',
      css: 'CSS',
      html: 'HTML',
      py: 'Python',
      sh: 'Shell',
    }[extension ?? ''] ?? 'Plain text'
  );
};

export const FileInspector = ({
  document,
}: Readonly<{ document: WorkspaceInspectDocument | null }>) => {
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
  const displayedLines = Math.max(
    1,
    (document.content.match(/\n/gu)?.length ?? 0) +
      (document.content.endsWith('\n') ? 0 : 1),
  );
  const lineNumbers = Array.from(
    { length: displayedLines },
    (_, index) => index + 1,
  ).join('\n');
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`File inspector ${document.path}`}>
      <header className="border-b px-4 py-3">
        <p className="truncate text-sm font-medium" title={document.path}>
          {document.path}
        </p>
        <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-tertiary">
          {languageForPath(document.path)} · {document.bytes.toLocaleString()} bytes · {document.lines.toLocaleString()} lines
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
          <pre className="m-0 whitespace-pre px-4 py-3 text-foreground"><code>{document.content}</code></pre>
        </div>
      </div>
    </section>
  );
};
