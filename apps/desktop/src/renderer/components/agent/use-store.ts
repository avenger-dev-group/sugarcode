import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore as useZustandStore } from 'zustand';

import { resolveWorkspaceFile } from '@/renderer/services/workspace';
import { workspaceProjectionStore } from '@/renderer/stores/workspace-projection-store';

import type {
  FileReferenceLinkStore,
  FileReferenceResolution,
} from './types';

const resolutionCache = new Map<
  string,
  Promise<FileReferenceResolution>
>();

const requestResolution = (
  generation: number,
  path: string,
): Promise<FileReferenceResolution> => {
  if (path.includes('/')) {
    return Promise.resolve({ status: 'resolved', path });
  }
  const key = `${generation}:${path}`;
  const cached = resolutionCache.get(key);
  if (cached) {
    return cached;
  }
  if (resolutionCache.size >= 128) {
    resolutionCache.clear();
  }
  const request = resolveWorkspaceFile({ generation, name: path })
    .then((result): FileReferenceResolution => {
      if (!result.accepted || result.generation !== generation) {
        return { status: 'unavailable' };
      }
      if (result.status === 'resolved') {
        return result.path
          ? { status: 'resolved', path: result.path }
          : { status: 'unavailable' };
      }
      return { status: result.status };
    })
    .catch((): FileReferenceResolution => ({ status: 'unavailable' }));
  resolutionCache.set(key, request);
  return request;
};

export const useStore = (
  path: string,
  openFile: (path: string) => void,
): FileReferenceLinkStore => {
  const workspace = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.snapshot,
  );
  const [resolution, setResolution] =
    useState<FileReferenceResolution>(() =>
      path.includes('/')
        ? { status: 'resolved', path }
        : { status: 'idle' },
    );
  const requestRevision = useRef<number>(0);

  useEffect(() => {
    requestRevision.current += 1;
    setResolution(
      path.includes('/')
        ? { status: 'resolved', path }
        : { status: 'idle' },
    );
  }, [path, workspace.generation]);

  const resolveLocation = useCallback(async (): Promise<FileReferenceResolution> => {
    if (resolution.status !== 'idle') {
      return resolution;
    }
    if (workspace.status !== 'ready') {
      const unavailable = { status: 'unavailable' } as const;
      setResolution(unavailable);
      return unavailable;
    }
    const revision = ++requestRevision.current;
    setResolution({ status: 'loading' });
    const result = await requestResolution(workspace.generation, path);
    if (revision === requestRevision.current) {
      setResolution(result);
    }
    return result;
  }, [path, resolution, workspace.generation, workspace.status]);

  const prepare = useCallback((): void => {
    void resolveLocation();
  }, [resolveLocation]);

  const open = useCallback(async (): Promise<void> => {
    const result = await resolveLocation();
    openFile(result.status === 'resolved' ? result.path : path);
  }, [openFile, path, resolveLocation]);

  const locationLabel = (() => {
    switch (resolution.status) {
      case 'resolved':
        return resolution.path;
      case 'loading':
        return `正在项目中定位 ${path}…`;
      case 'ambiguous':
        return `项目中存在多个 ${path}，请使用完整相对路径`;
      case 'notFound':
        return `未在当前项目中找到 ${path}`;
      case 'unavailable':
        return `暂时无法定位 ${path}`;
      default:
        return path;
    }
  })();

  return { locationLabel, open, prepare };
};
