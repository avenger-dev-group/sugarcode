import { BookOpenText } from 'lucide-react';

import { AgentMarkdown } from '../agent/agent-markdown';
import { ScrollArea } from '../ui/scroll-area';
import type { SkillDocumentProps } from './types';

export const SkillDocument = ({
  name,
  description,
  content,
}: SkillDocumentProps) => (
  <article className="flex h-full min-h-0 flex-col">
    <header className="shrink-0 border-b px-5 py-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <BookOpenText
          className="size-4 shrink-0 text-link"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <h2 className="truncate text-sm font-medium text-primary">
          {name} Skill
        </h2>
      </div>
      {description ? (
        <p className="mt-1.5 text-xs font-normal leading-normal text-secondary">
          {description}
        </p>
      ) : null}
    </header>
    <ScrollArea
      className="min-h-0 flex-1"
      scrollbars="both"
      viewportProps={{
        'aria-label': `${name} Skill 内容`,
        className: '[&>div]:min-w-full',
      }}
    >
      <div className="min-w-full px-5 py-4">
        <AgentMarkdown source={content} isStreaming={false} />
      </div>
    </ScrollArea>
  </article>
);
