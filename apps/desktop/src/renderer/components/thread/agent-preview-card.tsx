import {
  ExternalLink,
  FolderOpen,
  Globe2,
  LoaderCircle,
  MonitorUp,
} from 'lucide-react';
import { useState } from 'react';
import { useStore as useZustandStore } from 'zustand';

import { useOrchestrationActions } from '@/renderer/components/orchestration/use-store';
import { Button } from '@/renderer/components/ui/button';
import {
  openArtifactPreview,
  openExternalArtifactPreview,
  openExternalPreview,
  openPreview as openEmbeddedPreview,
  revealPreviewArtifact,
} from '@/renderer/services/preview';
import { workspaceProjectionStore } from '@/renderer/stores/workspace-projection-store';
import type { PreviewActionResult } from '@/shared/preview';
import type { AgentPreviewIntent } from '@/shared/preview-intent';

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
  intent,
  language,
}: Readonly<{
  intent: Exclude<AgentPreviewIntent, { kind: 'drawio' }>;
  language: ProcessLanguage;
}>) => {
  const { openPreview } = useOrchestrationActions();
  const workspace = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.snapshot,
  );
  const [pending, setPending] = useState<
    'embedded' | 'external' | 'reveal' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const ready = workspace.status === 'ready';

  const run = async (
    target: 'embedded' | 'external' | 'reveal',
  ): Promise<void> => {
    if (!ready || pending) {
      return;
    }
    setPending(target);
    setError(null);
    try {
      let result: PreviewActionResult;
      if (intent.kind === 'artifact') {
        if (target === 'embedded') {
          result = await openArtifactPreview({
            previewId: openPreview(intent.path),
            generation: workspace.generation,
            path: intent.path,
          });
        } else if (target === 'external') {
          result = await openExternalArtifactPreview({
            generation: workspace.generation,
            path: intent.path,
          });
        } else {
          result = await revealPreviewArtifact({
            generation: workspace.generation,
            path: intent.path,
          });
        }
      } else {
        result = target === 'embedded'
          ? await openEmbeddedPreview({
              previewId: openPreview(intent.url),
              generation: workspace.generation,
              url: intent.url,
            })
          : await openExternalPreview({
              generation: workspace.generation,
              url: intent.url,
            });
      }
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
      className="agent-result-card overflow-hidden rounded-xl border border-border-subtle bg-[linear-gradient(115deg,var(--surface),var(--background)_68%)]"
      aria-label={language === 'zh' ? '网页预览选项' : 'Web preview options'}
    >
      <div className="agent-result-card__body">
        <span className="agent-result-card__icon grid size-10 place-items-center rounded-xl border border-border bg-background text-link shadow-sm">
          <Globe2 className="size-[18px]" aria-hidden="true" />
        </span>
        <span className="agent-result-card__summary">
          <span className="agent-result-card__title block text-sm font-medium text-foreground">
            {language === 'zh'
              ? intent.kind === 'artifact'
                ? '预览 HTML 成果'
                : '查看网页效果'
              : intent.kind === 'artifact'
                ? 'Preview HTML result'
                : 'View the web result'}
          </span>
          <code
            className="mt-1 block truncate font-mono text-[11px] text-tertiary"
            title={intent.kind === 'artifact' ? intent.path : intent.url}
          >
            {intent.kind === 'artifact' ? intent.path : intent.url}
          </code>
        </span>
        <div className="agent-result-card__actions">
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
          {intent.kind === 'artifact' ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 px-2.5 text-xs text-secondary"
              disabled={!ready || pending !== null}
              onClick={() => void run('reveal')}
            >
              {pending === 'reveal' ? (
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <FolderOpen className="size-3.5" aria-hidden="true" />
              )}
              {language === 'zh' ? '所在文件夹' : 'Show in folder'}
            </Button>
          ) : null}
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
