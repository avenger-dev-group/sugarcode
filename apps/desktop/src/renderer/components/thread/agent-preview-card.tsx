import { ExternalLink, Globe2, LoaderCircle, MonitorUp } from 'lucide-react';
import { useState } from 'react';
import { useStore as useZustandStore } from 'zustand';

import { useOrchestrationActions } from '@/renderer/components/orchestration/use-store';
import { Button } from '@/renderer/components/ui/button';
import {
  openExternalPreview,
  openPreview as openEmbeddedPreview,
} from '@/renderer/services/preview';
import { workspaceProjectionStore } from '@/renderer/stores/workspace-projection-store';
import type { PreviewActionResult } from '@/shared/preview';

import type { ProcessLanguage } from './types';

const resultError = (
  result: PreviewActionResult,
  language: ProcessLanguage,
): string | null => {
  if (result.accepted || result.reason === 'cancelled') {
    return null;
  }
  if (language === 'en') {
    return result.reason === 'stale'
      ? 'The workspace changed. Ask the Agent to verify the preview again.'
      : result.reason === 'busy'
        ? 'Finish the current confirmation before opening the preview.'
        : 'The verified preview could not be opened.';
  }
  return result.reason === 'stale'
    ? '工作区已切换，请让 Agent 重新确认预览地址。'
    : result.reason === 'busy'
      ? '请先处理当前确认操作，再打开预览。'
      : '无法打开已确认的预览地址。';
};

export const AgentPreviewCard = ({
  url,
  language,
}: Readonly<{
  url: string;
  language: ProcessLanguage;
}>) => {
  const { openPreview } = useOrchestrationActions();
  const workspace = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.snapshot,
  );
  const [pending, setPending] = useState<'embedded' | 'external' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = workspace.status === 'ready';

  const run = async (target: 'embedded' | 'external'): Promise<void> => {
    if (!ready || pending) {
      return;
    }
    setPending(target);
    setError(null);
    try {
      const result = target === 'embedded'
        ? await openEmbeddedPreview({
            previewId: openPreview(url),
            generation: workspace.generation,
            url,
          })
        : await openExternalPreview({ generation: workspace.generation, url });
      setError(resultError(result, language));
    } catch {
      setError(
        language === 'zh'
          ? '预览无法连接桌面主进程。'
          : 'Preview could not reach the desktop process.',
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      className="overflow-hidden rounded-xl border border-border-subtle bg-[linear-gradient(115deg,var(--surface),var(--background)_68%)]"
      aria-label={language === 'zh' ? '网页预览选项' : 'Web preview options'}
    >
      <div className="flex flex-col gap-3.5 px-4 py-3.5 sm:flex-row sm:items-center">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-background text-link shadow-sm">
          <Globe2 className="size-[18px]" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">
            {language === 'zh' ? '查看网页效果' : 'View the web result'}
          </span>
          <code
            className="mt-1 block truncate font-mono text-[11px] text-tertiary"
            title={url}
          >
            {url}
          </code>
        </span>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5 px-3 text-xs"
            disabled={!ready || pending !== null}
            onClick={() => void run('embedded')}
          >
            {pending === 'embedded' ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <MonitorUp className="size-3.5" aria-hidden="true" />
            )}
            {language === 'zh' ? '右侧预览' : 'Preview here'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 px-3 text-xs"
            disabled={!ready || pending !== null}
            onClick={() => void run('external')}
          >
            {pending === 'external' ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ExternalLink className="size-3.5" aria-hidden="true" />
            )}
            {language === 'zh' ? '浏览器打开' : 'Open in browser'}
          </Button>
        </div>
      </div>
      {error ? (
        <p className="border-t border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
};
