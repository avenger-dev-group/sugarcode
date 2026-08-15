import {
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  Link2,
} from 'lucide-react';

import type { WorkspaceEntry } from '@/shared/workspace';

import type { WorkspaceWorkbenchStore } from './types';

type TreeProps = Readonly<{
  store: WorkspaceWorkbenchStore;
  query?: string;
  parent?: string;
  depth?: number;
}>;

const entryMatchesQuery = (
  entry: WorkspaceEntry,
  query: string,
  store: WorkspaceWorkbenchStore,
): boolean => {
  if (!query || entry.name.toLocaleLowerCase().includes(query)) {
    return true;
  }
  if (entry.kind !== 'directory') {
    return false;
  }
  const children = store.entries.get(entry.path);
  return !children || children.some((child) =>
    entryMatchesQuery(child, query, store),
  );
};

export const FileTree = ({
  store,
  query = '',
  parent = '',
  depth = 0,
}: TreeProps) => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entries = (store.entries.get(parent) ?? []).filter((entry) =>
    entryMatchesQuery(entry, normalizedQuery, store),
  );
  if (store.loading.has(parent)) {
    return (
      <p className="px-3 py-2 font-mono text-[10px] text-tertiary">
        Reading directory…
      </p>
    );
  }
  if (entries.length === 0) {
    return depth === 0 ? (
      <p className="px-3 py-4 text-xs text-tertiary">Empty workspace</p>
    ) : null;
  }
  return (
    <ul role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? 'Workspace files' : undefined}>
      {entries.map((entry) => (
        <TreeEntry
          key={entry.path}
          entry={entry}
          depth={depth}
          store={store}
          query={query}
        />
      ))}
    </ul>
  );
};

const TreeEntry = ({
  entry,
  depth,
  store,
  query,
}: Readonly<{
  entry: WorkspaceEntry;
  depth: number;
  store: WorkspaceWorkbenchStore;
  query: string;
}>) => {
  const directory = entry.kind === 'directory';
  const isExpanded = directory && store.expanded.has(entry.path);
  const disabled = entry.kind === 'link' || entry.kind === 'other';
  const selected = store.selectedPath === entry.path;
  return (
    <li
      role="treeitem"
      aria-expanded={directory ? isExpanded : undefined}
      aria-selected={selected}
    >
      <button
        type="button"
        disabled={disabled}
        className={`group flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
          selected
            ? 'bg-link/10 text-link hover:bg-link/10'
            : 'text-secondary hover:bg-surface-hover hover:text-foreground'
        } disabled:cursor-not-allowed disabled:opacity-45`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        title={disabled ? 'Links and special entries are not opened.' : entry.path}
        onClick={() => {
          if (directory) {
            void store.toggleDirectory(entry.path);
          } else if (entry.kind === 'file') {
            void store.openFile(entry.path);
          }
        }}
        onKeyDown={(event) => {
          if (directory && event.key === 'ArrowRight' && !isExpanded) {
            event.preventDefault();
            void store.toggleDirectory(entry.path);
          } else if (directory && event.key === 'ArrowLeft' && isExpanded) {
            event.preventDefault();
            void store.toggleDirectory(entry.path);
          }
        }}
      >
        {directory ? (
          <ChevronRight
            className={`size-3 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
        ) : (
          <span className="w-3 shrink-0" aria-hidden="true" />
        )}
        {entry.kind === 'directory' ? (
          isExpanded ? <FolderOpen className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />
        ) : entry.kind === 'link' ? (
          <Link2 className="size-3.5 shrink-0" />
        ) : (
          <FileCode2 className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {directory && isExpanded ? (
        <FileTree store={store} query={query} parent={entry.path} depth={depth + 1} />
      ) : null}
    </li>
  );
};
