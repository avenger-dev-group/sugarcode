import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { VIDEO_PREVIEW_SCHEME } from '../../shared/preview.ts';
import type { WorkspaceLaunchContext } from '../workspace/controller';
import { resolvePreviewArtifact } from './artifact-file.ts';

type VideoGrant = Readonly<{
  workspace: WorkspaceLaunchContext;
  path: string;
  absolutePath: string;
  abort: AbortController;
}>;

// Single byte ranges are sufficient for HTMLMediaElement seeking. Do not buffer
// an entire video or permit paths supplied by the protocol request.
export const videoByteRange = (
  value: string | null,
  size: number,
): { start: number; end: number } | null => {
  if (!value || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    start >= 0 && start < size && end >= start
    ? { start, end }
    : null;
};

export class VideoPreviewMedia {
  private readonly grants = new Map<string, VideoGrant>();
  private readonly getWorkspace: () => WorkspaceLaunchContext | null;

  constructor(getWorkspace: () => WorkspaceLaunchContext | null) {
    this.getWorkspace = getWorkspace;
  }

  grant = (
    workspace: WorkspaceLaunchContext,
    path: string,
    absolutePath: string,
  ): { sessionId: string; url: string } => {
    const sessionId = randomUUID();
    this.grants.set(sessionId, { workspace, path, absolutePath, abort: new AbortController() });
    return { sessionId, url: `${VIDEO_PREVIEW_SCHEME}://media/${sessionId}` };
  };

  revoke = (sessionId: string): void => {
    this.grants.get(sessionId)?.abort.abort();
    this.grants.delete(sessionId);
  };

  clear = (): void => {
    for (const id of this.grants.keys()) this.revoke(id);
  };

  respond = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.protocol !== `${VIDEO_PREVIEW_SCHEME}:` || url.hostname !== 'media' ||
      url.search || url.hash || url.username || url.password || url.port
    ) return new Response(null, { status: 404 });
    const grant = this.grants.get(url.pathname.slice(1));
    const workspace = this.getWorkspace();
    if (
      !grant || !workspace ||
      workspace.generation !== grant.workspace.generation ||
      workspace.workspaceId !== grant.workspace.workspaceId ||
      workspace.threadId !== grant.workspace.threadId ||
      workspace.path !== grant.workspace.path
    ) return new Response(null, { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const artifact = await resolvePreviewArtifact(workspace, grant.path);
    if (artifact?.absolutePath !== grant.absolutePath || grant.abort.signal.aborted) {
      return new Response(null, { status: 404 });
    }
    const file = await open(grant.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch((): null => null);
    if (!file) return new Response(null, { status: 404 });
    try {
      const info = await file.stat();
      if (!info.isFile()) {
        await file.close();
        return new Response(null, { status: 404 });
      }
      const rangeHeader = request.headers.get('range');
      const range = videoByteRange(rangeHeader, info.size);
      const headers = new Headers({
        'Content-Type': /\.webm$/iu.test(grant.path)
          ? 'video/webm'
          : /\.mov$/iu.test(grant.path) ? 'video/quicktime' : 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (rangeHeader && !range) {
        await file.close();
        headers.set('Content-Range', `bytes */${info.size}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Length', String(range ? range.end - range.start + 1 : info.size));
      if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
      if (request.method === 'HEAD' || info.size === 0) {
        await file.close();
        return new Response(null, { status: range ? 206 : 200, headers });
      }
      const stream = file.createReadStream({
        ...(range ?? {}),
        autoClose: true,
        signal: AbortSignal.any([request.signal, grant.abort.signal]),
      });
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        status: range ? 206 : 200,
        headers,
      });
    } catch {
      await file.close().catch((): undefined => undefined);
      return new Response(null, { status: 500 });
    }
  };
}
