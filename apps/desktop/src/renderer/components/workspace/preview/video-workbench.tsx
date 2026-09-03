import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Film, FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import {
  openArtifactPreview,
  openExternalArtifactPreview,
  revealPreviewArtifact,
} from '@/renderer/services/preview';
import type { PreviewActionResult } from '@/shared/preview';
import type { PreviewWorkbenchState } from './types';

export const VideoWorkbench = ({
  active,
  path,
  previewId,
  generation,
  state,
}: Readonly<{
  active: boolean;
  path: string;
  previewId: string;
  generation: number;
  state: PreviewWorkbenchState;
}>) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [metadata, setMetadata] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const source = state.status === 'video' ? state.url : undefined;

  useEffect(() => {
    if (!active) videoRef.current?.pause();
  }, [active]);

  useEffect(() => {
    setMetadata(undefined);
    setError(undefined);
    const video = videoRef.current;
    return () => { video?.pause(); };
  }, [source]);

  const run = async (action: () => Promise<PreviewActionResult>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await action();
      if (!result.accepted && result.reason !== 'cancelled') {
        setError(result.reason === 'stale'
          ? '工作区已切换，请从当前对话重新打开视频。'
          : '无法打开视频，请确认文件仍然存在，或使用默认播放器查看。');
      }
    } catch {
      setError('无法连接视频查看服务，请重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="视频查看器">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2.5">
        <Film className="size-4 shrink-0 text-link" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={path}>{path.split('/').at(-1)}</p>
          <p className="mt-0.5 text-[10px] text-tertiary">视频 · 本地文件</p>
        </div>
        <Button variant="ghost" size="icon-sm" disabled={busy} aria-label="重新加载视频"
          onClick={() => void run(() => openArtifactPreview({ previewId, generation, path }))}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </Button>
        <Button variant="outline" size="sm" disabled={busy} className="gap-1.5 text-xs"
          onClick={() => void run(() => openExternalArtifactPreview({ generation, path }))}>
          <ExternalLink className="size-3.5" aria-hidden="true" />默认播放器
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={busy} aria-label="打开视频所在文件夹"
          onClick={() => void run(() => revealPreviewArtifact({ generation, path }))}>
          <FolderOpen className="size-3.5" aria-hidden="true" />
        </Button>
      </header>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#101216] p-3">
        {source ? (
          <video
            key={source}
            ref={videoRef}
            src={source}
            controls
            playsInline
            preload="metadata"
            className="max-h-full w-full rounded-md object-contain shadow-2xl"
            aria-label={`播放 ${path.split('/').at(-1)}`}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              const duration = Number.isFinite(video.duration) ? Math.round(video.duration) : 0;
              setMetadata(`${video.videoWidth} × ${video.videoHeight} · ${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`);
            }}
            onError={(event) => {
              const code = event.currentTarget.error?.code;
              setError(code === 3 || code === 4
                ? '此视频编码无法在内置播放器中解码。请使用默认播放器，或重新导出为 H.264 + AAC 的 MP4。'
                : '视频读取失败，文件可能已移动或被替换。请重新加载或打开所在文件夹检查。');
            }}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-center text-white/60">
            {busy ? <LoaderCircle className="size-6 animate-spin" aria-hidden="true" /> : <Film className="size-8" aria-hidden="true" />}
            <p className="text-xs">{busy ? '正在读取视频…' : '等待打开视频'}</p>
            <Button variant="secondary" size="sm" disabled={busy}
              onClick={() => void run(() => openArtifactPreview({ previewId, generation, path }))}>
              打开视频
            </Button>
          </div>
        )}
      </div>
      {error ? <p className="shrink-0 border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">{error}</p> : null}
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border-subtle px-3 py-2 font-mono text-[10px] text-tertiary">
        <span className="min-w-0 truncate" title={path}>{path}</span>
        <span>{metadata ?? '播放 / 拖动进度 / 音量 / 全屏'}</span>
      </footer>
    </section>
  );
};
