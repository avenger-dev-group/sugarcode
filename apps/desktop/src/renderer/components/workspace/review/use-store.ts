import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore as useZustandStore } from 'zustand';

import { inspectWorkspace } from '@/renderer/services/workspace';
import { workspaceProjectionStore } from '@/renderer/stores/workspace-projection-store';
import type { WorkspaceInspectDocument } from '@/shared/workspace';

import type { WorkspaceDocumentStore } from './types';

export const useStore = (path: string): WorkspaceDocumentStore => {
  const workspace = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.snapshot,
  );
  const [document, setDocument] =
    useState<WorkspaceInspectDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const requestRevision = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const revision = ++requestRevision.current;
    if (workspace.status !== 'ready') {
      setDocument(null);
      setError('请先打开此文件所属的项目。');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const result = await inspectWorkspace({
      generation: workspace.generation,
      path,
    }).catch((): null => null);
    if (revision !== requestRevision.current) {
      return;
    }
    setLoading(false);
    if (
      !result ||
      !result.accepted ||
      result.generation !== workspace.generation
    ) {
      setDocument(null);
      setError('无法安全读取所选文件。');
      return;
    }
    setDocument(result.document);
  }, [path, workspace.generation, workspace.status]);

  useEffect(() => {
    void reload();
    return () => {
      requestRevision.current += 1;
    };
  }, [reload]);

  return { document, error, loading, reload };
};
