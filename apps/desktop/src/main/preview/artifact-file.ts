import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { WorkspaceLaunchContext } from '../workspace/controller';

export type ResolvedPreviewArtifact = Readonly<{
  absolutePath: string;
  root: string;
  url: string;
}>;

const within = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative.length === 0 ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`));
};

export const resolvePreviewArtifact = async (
  workspace: WorkspaceLaunchContext,
  relativePath: string,
): Promise<ResolvedPreviewArtifact | null> => {
  const workspaceRoot = await realpath(workspace.path).catch((): null => null);
  if (!workspaceRoot) {
    return null;
  }
  const candidate = path.resolve(workspaceRoot, ...relativePath.split('/'));
  if (!within(workspaceRoot, candidate)) {
    return null;
  }
  const absolutePath = await realpath(candidate).catch((): null => null);
  if (!absolutePath || !within(workspaceRoot, absolutePath)) {
    return null;
  }
  const metadata = await stat(absolutePath).catch((): null => null);
  if (!metadata?.isFile() || !/\.html?$/iu.test(path.extname(absolutePath))) {
    return null;
  }
  return {
    absolutePath,
    root: path.dirname(absolutePath),
    url: pathToFileURL(absolutePath).toString(),
  };
};
