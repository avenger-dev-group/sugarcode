import path from 'node:path';

import { isAbsoluteWorkspaceFileReference } from '../../shared/workspace-file-reference.ts';

export type AbsoluteWorkspaceFileResolution =
  | Readonly<{ status: 'resolved'; path: string }>
  | Readonly<{ status: 'outsideWorkspace' }>;

const hasTraversalComponent = (reference: string): boolean =>
  reference
    .split(/[\\/]/u)
    .some((component) => component === '.' || component === '..');

const usesWindowsPathSyntax = (value: string): boolean =>
  /^[a-z]:[\\/]/iu.test(value) ||
  value.startsWith('\\\\') ||
  value.startsWith('//');

export const resolveAbsoluteWorkspaceFileReference = (
  canonicalRoot: string,
  reference: string,
): AbsoluteWorkspaceFileResolution => {
  if (
    !isAbsoluteWorkspaceFileReference(reference) ||
    hasTraversalComponent(reference)
  ) {
    return { status: 'outsideWorkspace' };
  }

  const rootUsesWindowsPathSyntax = usesWindowsPathSyntax(canonicalRoot);
  if (rootUsesWindowsPathSyntax !== usesWindowsPathSyntax(reference)) {
    return { status: 'outsideWorkspace' };
  }
  const pathApi = rootUsesWindowsPathSyntax ? path.win32 : path.posix;
  const root = pathApi.resolve(canonicalRoot);
  const candidate = pathApi.resolve(reference);
  const relative = pathApi.relative(root, candidate);
  if (
    relative.length === 0 ||
    pathApi.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${pathApi.sep}`)
  ) {
    return { status: 'outsideWorkspace' };
  }
  return {
    status: 'resolved',
    path: relative.split(pathApi.sep).join('/'),
  };
};
