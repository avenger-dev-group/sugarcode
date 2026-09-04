import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const readArtifactBytes = async (file: string): Promise<Buffer> => {
  if ((await lstat(file)).size > 25 * 1024 * 1024) throw new Error('文件超过 25 MB，请使用系统应用打开。');
  const bytes = await readFile(file);
  if (bytes.length > 25 * 1024 * 1024) throw new Error('文件超过 25 MB，请使用系统应用打开。');
  return bytes;
};

/** Application metadata must not follow workspace-controlled symlinks. */
export const metadataDirectory = async (root: string, segments: string[], create = true): Promise<string> => {
  let current = root;
  for (const segment of ['.sugarcode', ...segments]) {
    current = path.join(current, segment);
    if (create) await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current).catch((error: NodeJS.ErrnoException): undefined => { if (!create && error.code === 'ENOENT') return undefined; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('文件记录目录不能经过符号链接。');
  }
  return current;
};

export const replaceFile = async (file: string, bytes: Uint8Array, mode = 0o600): Promise<void> => {
  const temporary = path.join(path.dirname(file), `.sugarcode-save-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { mode, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
};
