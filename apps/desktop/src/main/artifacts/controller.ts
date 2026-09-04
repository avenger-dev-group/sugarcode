import { createHash } from 'node:crypto';
import { copyFile, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow, Dialog } from 'electron';
import { artifactKind, type ArtifactDocument, type ArtifactEdits } from '../../shared/artifacts.ts';
import type { WorkspaceLaunchContext } from '../workspace/controller.ts';
import { editWord, editWorkbook, readWordParagraphs, readWorkbook } from './office.ts';
import { metadataDirectory, readArtifactBytes, replaceFile } from './files.ts';

type Options = Readonly<{
  dialog: Pick<Dialog, 'showSaveDialog'>;
  getMainWindow: () => BrowserWindow | null;
  getWorkspace: () => WorkspaceLaunchContext | null;
  openPath: (path: string) => Promise<void>;
  reveal: (path: string) => void;
}>;
const within = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };

export class ArtifactsController {
  private readonly options: Options;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(options: Options) { this.options = options; }

  read = async (generation: number, relativePath: string): Promise<ArtifactDocument> => {
    const resolved = await this.resolve(generation, relativePath);
    const bytes = await readArtifactBytes(resolved.path);
    const revision = createHash('sha256').update(bytes).digest('hex');
    const identity = createHash('sha256').update(`${resolved.root}\0${relativePath}`).digest('hex');
    const kind = artifactKind(relativePath);
    const base = { path: relativePath, identity, revision, kind, bytes: bytes.length } as const;
    if (kind === 'text') {
      if (bytes.length > 2_000_000) throw new Error('文本文件超过 2 MB，请使用系统应用打开。');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content.includes('\0')) throw new Error('此文件不是可编辑的 UTF-8 文本。');
      return { ...base, content };
    }
    if (kind === 'docx') return { ...base, data: bytes.toString('base64'), paragraphs: await readWordParagraphs(bytes) };
    if (kind === 'xlsx') return { ...base, sheets: await readWorkbook(bytes) };
    if (kind === 'pdf') {
      const notes = await this.readNotes(resolved.root, identity);
      return { ...base, data: bytes.toString('base64'), mediaType: 'application/pdf', notes: notes.content, notesRevision: notes.revision };
    }
    if (kind === 'image') {
      const ext = relativePath.split('.').at(-1)?.toLocaleLowerCase() ?? '';
      const data = ext === 'svg' ? Buffer.from(this.sanitizeSvg(bytes.toString('utf8'))).toString('base64') : bytes.toString('base64');
      return { ...base, data, mediaType: mime[ext] ?? 'application/octet-stream' };
    }
    return base;
  };

  save = <T extends ArtifactEdits>(generation: number, relativePath: string, expectedRevision: string, edits: T): Promise<ArtifactDocument> => this.lock(async () => {
    const resolved = await this.resolve(generation, relativePath);
    const bytes = await readArtifactBytes(resolved.path);
    const current = createHash('sha256').update(bytes).digest('hex');
    if (current !== expectedRevision) throw Object.assign(new Error('文件已在其他位置发生变化，请重新读取后再编辑。'), { code: 'CONFLICT' });
    const kind = artifactKind(relativePath);
    if (edits.kind !== kind) throw new Error('编辑内容与文件类型不匹配。');
    if (edits.kind === 'pdf') {
      const identity = createHash('sha256').update(`${resolved.root}\0${relativePath}`).digest('hex');
      await this.saveNotes(resolved.root, identity, edits.notes, edits.notesRevision);
      return this.read(generation, relativePath);
    }
    let output: Buffer;
    if (edits.kind === 'text' && kind === 'text') {
      output = Buffer.from(edits.content, 'utf8');
      if (output.length > 2_000_000) throw new Error('文本内容超过 2 MB。');
      if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) output = Buffer.concat([bytes.subarray(0, 3), output]);
    }
    else if (edits.kind === 'docx' && kind === 'docx') output = await editWord(bytes, edits);
    else if (edits.kind === 'xlsx' && kind === 'xlsx') output = await editWorkbook(bytes, edits);
    else throw new Error('编辑内容与文件类型不匹配。');
    const versionDir = await metadataDirectory(resolved.root, ['versions', createHash('sha256').update(relativePath).digest('hex')]);
    const latest = await readArtifactBytes(resolved.path);
    if (!latest.equals(bytes)) throw Object.assign(new Error('文件在保存过程中发生变化，请重新读取。'), { code: 'CONFLICT' });
    await writeFile(path.join(versionDir, `${Date.now()}-${current}-${path.basename(relativePath)}`), bytes, { mode: 0o600 });
    await replaceFile(resolved.path, output, (await lstat(resolved.path)).mode);
    return this.read(generation, relativePath);
  });

  openExternal = async (generation: number, relativePath: string): Promise<void> => this.options.openPath((await this.resolve(generation, relativePath)).path);
  reveal = async (generation: number, relativePath: string): Promise<void> => this.options.reveal((await this.resolve(generation, relativePath)).path);
  export = async (generation: number, relativePath: string): Promise<void> => {
    const resolved = await this.resolve(generation, relativePath);
    const parent = this.options.getMainWindow();
    const options = { title: '导出产物', defaultPath: path.basename(relativePath) };
    const choice = await (parent ? this.options.dialog.showSaveDialog(parent, options) : this.options.dialog.showSaveDialog(options));
    if (!choice.canceled && choice.filePath) await copyFile(resolved.path, choice.filePath);
  };
  private resolve = async (generation: number, relativePath: string): Promise<{ root: string; path: string }> => {
    const workspace = this.options.getWorkspace();
    if (!workspace || workspace.generation !== generation || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).some((part) => !part || part === '.' || part === '..')) throw new Error('文件不属于当前工作目录。');
    const root = await realpath(workspace.path);
    const candidate = await realpath(path.resolve(root, ...relativePath.split(/[\\/]/u)));
    if (!within(root, candidate) || !(await lstat(candidate)).isFile()) throw new Error('文件不属于当前工作目录。');
    return { root, path: candidate };
  };
  private notesSource = async (root: string, identity: string): Promise<string> => {
    const directory = await metadataDirectory(root, ['reviews'], false);
    const file = path.join(directory, `${identity}.json`);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 500_000) throw new Error('批注文件无效。');
      return await readFile(file, 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  };
  private readNotes = async (root: string, identity: string): Promise<{ content: string; revision: string }> => {
    const source = await this.notesSource(root, identity);
    const content = source ? String((JSON.parse(source) as { notes?: unknown }).notes ?? '') : '';
    return { content, revision: createHash('sha256').update(source).digest('hex') };
  };
  private saveNotes = async (root: string, identity: string, notes: string, expected: string): Promise<void> => {
    const source = await this.notesSource(root, identity);
    if (createHash('sha256').update(source).digest('hex') !== expected) throw Object.assign(new Error('批注已发生变化，请重新读取。'), { code: 'CONFLICT' });
    const directory = await metadataDirectory(root, ['reviews']);
    await replaceFile(path.join(directory, `${identity}.json`), Buffer.from(JSON.stringify({ notes, updatedAt: Date.now() })));
  };
  private sanitizeSvg = (source: string): string => source
    .replace(/<script\b[\s\S]*?<\/script>/giu, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*(["'])\s*(?:https?:|file:)[\s\S]*?\1/giu, '')
    .replace(/\s(on\w+)\s*=\s*(["'])[\s\S]*?\2/giu, '');
  private lock = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = this.serial.then(operation);
    this.serial = result.catch((): undefined => undefined);
    return result;
  };
}
