import { useCallback, useEffect, useRef, useState } from 'react';

import { resolveWorkspaceFile } from '@/renderer/services/workspace';
import { isAbsoluteWorkspaceFileReference } from '@/shared/workspace-file-reference';

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
  if (
    path.includes('/') &&
    !isAbsoluteWorkspaceFileReference(path)
  ) {
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
  const request = resolveWorkspaceFile({ generation, reference: path })
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
  exactPath: boolean,
  openFile: (path: string) => void,
  workspaceGeneration: number,
  workspaceReady: boolean,
): FileReferenceLinkStore => {
  const requiresResolution =
    !exactPath &&
    (isAbsoluteWorkspaceFileReference(path) || !path.includes('/'));
  const [resolution, setResolution] =
    useState<FileReferenceResolution>(() =>
      requiresResolution ? { status: 'idle' } : { status: 'resolved', path },
    );
  const requestRevision = useRef<number>(0);
  const pendingResolution =
    useRef<Promise<FileReferenceResolution> | null>(null);

  useEffect(() => {
    requestRevision.current += 1;
    pendingResolution.current = null;
    setResolution(
      requiresResolution ? { status: 'idle' } : { status: 'resolved', path },
    );
  }, [path, requiresResolution, workspaceGeneration, workspaceReady]);

  const resolveLocation = useCallback(async (): Promise<FileReferenceResolution> => {
    if (resolution.status !== 'idle' && resolution.status !== 'loading') {
      return resolution;
    }
    if (pendingResolution.current) {
      return pendingResolution.current;
    }
    if (!workspaceReady) {
      const unavailable = { status: 'unavailable' } as const;
      setResolution(unavailable);
      return unavailable;
    }
    const revision = ++requestRevision.current;
    setResolution({ status: 'loading' });
    const nativeRequest = requestResolution(workspaceGeneration, path);
    const guardedRequest = nativeRequest.then(
      (result): FileReferenceResolution => {
        if (revision !== requestRevision.current) {
          return { status: 'unavailable' };
        }
        setResolution(result);
        return result;
      },
    );
    pendingResolution.current = guardedRequest;
    void guardedRequest.finally(() => {
      if (pendingResolution.current === guardedRequest) {
        pendingResolution.current = null;
      }
    });
    return guardedRequest;
  }, [path, resolution, workspaceGeneration, workspaceReady]);

  const prepare = useCallback((): void => {
    void resolveLocation();
  }, [resolveLocation]);

  const open = useCallback(async (): Promise<void> => {
    const result = await resolveLocation();
    if (result.status === 'resolved') {
      openFile(result.path);
    }
  }, [openFile, resolveLocation]);

  const locationLabel = (() => {
    switch (resolution.status) {
      case 'resolved':
        return isAbsoluteWorkspaceFileReference(path)
          ? path
          : resolution.path;
      case 'loading':
        return `正在项目中定位 ${path}…`;
      case 'ambiguous':
        return `项目中存在多个 ${path}，请使用完整相对路径`;
      case 'outsideWorkspace':
        return '该文件引用不属于当前项目';
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
