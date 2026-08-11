import { BookOpenText, LoaderCircle } from 'lucide-react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/renderer/components/ui/tooltip';
import { useOrchestrationStore } from '../orchestration/use-store';
import type { SkillActivityProps } from './types';

const terminalSentence = (value: string, language: SkillActivityProps['language']): string => {
  const trimmed = value.trim();
  return /[.!?。！？]$/u.test(trimmed)
    ? trimmed
    : `${trimmed}${language === 'zh' ? '。' : '.'}`;
};

const appliedPurpose = ({
  activity,
  language,
}: SkillActivityProps): string => {
  if (activity.purpose) {
    return terminalSentence(activity.purpose, language);
  }
  const descriptionMatchesLanguage = activity.description &&
    (language === 'zh'
      ? /\p{Script=Han}/u.test(activity.description)
      : !/\p{Script=Han}/u.test(activity.description));
  if (descriptionMatchesLanguage && activity.description) {
    return terminalSentence(activity.description, language);
  }
  return language === 'zh'
    ? '按照该 Skill 的专用流程处理当前任务。'
    : 'Applied its specialized workflow to the current task.';
};

const SkillReference = ({
  activity,
  language,
}: Pick<SkillActivityProps, 'activity' | 'language'>) => {
  const { openSkill } = useOrchestrationStore();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex max-w-full cursor-pointer items-baseline gap-1 text-link underline decoration-link-muted underline-offset-[3px] transition-[color,text-decoration-color] hover:text-link-hover hover:decoration-link focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            if (!activity.content) {
              return;
            }
            openSkill({
              kind: 'skill',
              name: activity.name,
              ...(activity.description
                ? { description: activity.description }
                : {}),
              content: activity.content,
            });
          }}
          aria-label={
            language === 'zh'
              ? `在右侧打开 ${activity.name} Skill`
              : `Open ${activity.name} Skill on the right`
          }
        >
          <BookOpenText
            className="size-3 shrink-0 self-center"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="font-mono text-[0.92em] font-normal">
            {activity.name}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {language === 'zh' ? '在右侧查看' : 'Open on the right:'}{' '}
        {activity.name} Skill
      </TooltipContent>
    </Tooltip>
  );
};

export const SkillActivity = ({ activity, language }: SkillActivityProps) => {
  if (activity.state === 'succeeded' && activity.content) {
    return (
      <p className="my-1 min-w-0 text-sm font-normal leading-[22px] text-primary">
        {language === 'zh' ? '本次使用 ' : 'Used '}
        <SkillReference activity={activity} language={language} />
        {' Skill'}
        {language === 'zh' ? '，' : ' — '}
        {appliedPurpose({ activity, language })}
      </p>
    );
  }

  if (activity.state === 'failed') {
    return (
      <p
        className="my-1 text-sm font-normal leading-[22px] text-destructive"
        role="alert"
      >
        {language === 'zh' ? '加载 ' : 'Could not load '}
        <code className="font-mono text-[0.92em]">{activity.name} Skill</code>
        {activity.errorKind ? ` · ${activity.errorKind}` : null}
      </p>
    );
  }

  const loading = activity.state === 'running' || activity.state === 'stopping';
  const copy = language === 'zh'
    ? activity.state === 'interrupted'
      ? '已停止加载'
      : activity.state === 'uncertain'
        ? 'Skill 加载状态未知'
        : '正在加载'
    : activity.state === 'interrupted'
      ? 'Stopped loading'
      : activity.state === 'uncertain'
        ? 'Skill load status unknown'
        : 'Loading';

  return (
    <p
      className="my-1 flex min-w-0 items-center gap-1.5 text-sm font-normal leading-[22px] text-process"
      role="status"
    >
      {loading ? (
        <LoaderCircle
          className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : null}
      <span>{copy}</span>
      <code className="truncate font-mono text-[0.92em] text-primary">
        {activity.name} Skill
      </code>
    </p>
  );
};
