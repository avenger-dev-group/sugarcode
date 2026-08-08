import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore as useZustandStore } from 'zustand';

import {
  inspectWorkspace,
  resolveWorkspaceFile,
} from '@/renderer/services/workspace';
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
    let resolvedPath = path;
    if (!path.includes('/')) {
      const resolution = await resolveWorkspaceFile({
        generation: workspace.generation,
        name: path,
      }).catch((): null => null);
      if (revision !== requestRevision.current) {
        return;
      }
      if (
        !resolution ||
        !resolution.accepted ||
        resolution.generation !== workspace.generation
      ) {
        setDocument(null);
        setError('无法安全定位所选文件。');
        setLoading(false);
        return;
      }
      if (resolution.status === 'ambiguous') {
        setDocument(null);
        setError(`项目中存在多个 ${path}，请使用完整相对路径。`);
        setLoading(false);
        return;
      }
      if (resolution.status === 'unavailable') {
        setDocument(null);
        setError('项目文件搜索暂时不可用，请稍后重试。');
        setLoading(false);
        return;
      }
      if (resolution.status === 'notFound' || !resolution.path) {
        setDocument({ status: 'error', path, kind: 'notFound' });
        setLoading(false);
        return;
      }
      resolvedPath = resolution.path;
    }
    const result = await inspectWorkspace({
      generation: workspace.generation,
      path: resolvedPath,
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
