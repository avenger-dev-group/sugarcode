import { useEffect, useRef, useState } from 'react';
import { useStore as useZustandStore } from 'zustand';

import {
  inspectWorkspace,
  listWorkspace,
  selectWorkspace,
} from '@/renderer/services/workspace';
import { workspaceProjectionStore } from '@/renderer/stores/workspace-projection-store';
import type {
  WorkspaceEntry,
  WorkspaceInspectDocument,
} from '@/shared/workspace';

import type { WorkspaceWorkbenchStore } from './types';

export const useStore = (): WorkspaceWorkbenchStore => {
  const [open, setOpen] = useState(false);
  const state = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.snapshot,
  );
  const projectionError = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.loadError,
  );
  const [entries, setEntries] = useState<
    ReadonlyMap<string, readonly WorkspaceEntry[]>
  >(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    new Set(['']),
  );
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [document, setDocument] =
    useState<WorkspaceInspectDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedGeneration = useRef<number | null>(null);

  const loadDirectory = async (
    path: string,
    snapshot = state,
  ): Promise<void> => {
    setLoading((current) => new Set(current).add(path));
    const result = await listWorkspace({
      generation: snapshot.generation,
      path,
    }).catch((): null => null);
    setLoading((current) => {
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    if (!result || !result.accepted) {
      setError('This directory could not be listed safely.');
      return;
    }
    setEntries((current) => {
      const next = new Map(current);
      next.set(path, result.entries);
      return next;
    });
    setError(null);
  };

  useEffect(() => {
    if (
      state.status !== 'ready' ||
      loadedGeneration.current === state.generation
    ) {
      return;
    }
    loadedGeneration.current = state.generation;
    setEntries(new Map());
    setExpanded(new Set(['']));
    setSelectedPath(null);
    setDocument(null);
    setError(null);
    void loadDirectory('', state);
  }, [state.generation, state.status]);

  const chooseWorkspace = async (): Promise<void> => {
    const result = await selectWorkspace().catch((): null => null);
    if (!result) {
      setError('The workspace picker could not be opened.');
    } else if (!result.accepted && result.reason !== 'cancelled') {
      setError(
        result.reason === 'busy'
          ? 'Finish the active operation before switching workspaces.'
          : 'The workspace could not be activated.',
      );
    }
  };

  const toggleDirectory = async (path: string): Promise<void> => {
    if (expanded.has(path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(path));
    if (!entries.has(path)) {
      await loadDirectory(path);
    }
  };

  const openFile = async (path: string): Promise<void> => {
    setSelectedPath(path);
    setDocument(null);
    setError(null);
    const result = await inspectWorkspace({
      generation: state.generation,
      path,
    }).catch((): null => null);
    if (!result || !result.accepted) {
      setError('The selected file could not be inspected safely.');
      return;
    }
    setDocument(result.document);
  };

  const refresh = async (): Promise<void> => {
    setEntries(new Map());
    setExpanded(new Set(['']));
    setDocument(null);
    setSelectedPath(null);
    if (state.status === 'ready') {
      await loadDirectory('');
    }
  };

  return {
    open,
    state,
    entries,
    expanded,
    loading,
    selectedPath,
    document,
    error: error ?? projectionError,
    setOpen,
    chooseWorkspace,
    toggleDirectory,
    openFile,
    refresh,
  };
};
