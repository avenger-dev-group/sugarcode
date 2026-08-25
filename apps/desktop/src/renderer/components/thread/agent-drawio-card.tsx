import { ArrowRight, FileCode2, Workflow } from 'lucide-react';

import { useOrchestrationActions } from '@/renderer/components/orchestration/use-store';
import { Button } from '@/renderer/components/ui/button';

import type { ProcessLanguage } from './types';

export const AgentDrawioCard = ({
  path,
  language,
}: Readonly<{ path: string; language: ProcessLanguage }>) => {
  const { openDrawio, openFile } = useOrchestrationActions();
  const chinese = language === 'zh';
  return (
    <section
      className="agent-result-card overflow-hidden rounded-xl border border-[#bfd9cc] bg-[linear-gradient(115deg,#edf7f1,var(--background)_70%)] dark:border-[#315c49] dark:bg-[linear-gradient(115deg,#173428,var(--background)_72%)]"
      aria-label={chinese ? 'Draw.io 图表成果' : 'Draw.io diagram result'}
    >
      <div className="agent-result-card__body">
        <span className="agent-result-card__icon grid size-10 place-items-center rounded-xl border border-[#cce1d6] bg-white text-[#287453] shadow-sm dark:border-[#3d6c57] dark:bg-[#173126] dark:text-[#70c69d]">
          <Workflow className="size-[18px]" aria-hidden="true" />
        </span>
        <span className="agent-result-card__summary">
          <span className="agent-result-card__title block text-sm font-medium text-foreground">
            {chinese ? '可编辑的 Draw.io 图表已生成' : 'Editable Draw.io diagram generated'}
          </span>
          <code className="mt-1 block truncate font-mono text-[11px] text-tertiary" title={path}>{path}</code>
        </span>
        <div className="agent-result-card__actions">
          <Button type="button" size="sm" className="h-8 gap-1.5 px-3 text-xs" onClick={() => openDrawio(path)}>
            <ArrowRight className="size-3.5" aria-hidden="true" />
            {chinese ? '查看图表' : 'View diagram'}
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 px-3 text-xs" onClick={() => openFile(path)}>
            <FileCode2 className="size-3.5" aria-hidden="true" />
            {chinese ? '查看 XML' : 'View XML'}
          </Button>
        </div>
      </div>
    </section>
  );
};
