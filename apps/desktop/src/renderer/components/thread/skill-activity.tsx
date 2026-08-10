import {
  Check,
  CircleHelp,
  LoaderCircle,
  Sparkles,
  Square,
  X,
} from 'lucide-react';

import type {
  SkillActivityPresentationState,
  SkillActivityProps,
} from './types';

const stateCopy = (
  state: SkillActivityPresentationState,
  language: SkillActivityProps['language'],
): string => {
  if (language === 'zh') {
    switch (state) {
      case 'running':
        return '正在应用';
      case 'stopping':
        return '正在停止';
      case 'uncertain':
        return '状态未知';
      case 'succeeded':
        return '已应用';
      case 'failed':
        return '加载失败';
      case 'interrupted':
        return '已停止';
    }
  }
  switch (state) {
    case 'running':
      return 'Applying';
    case 'stopping':
      return 'Stopping';
    case 'uncertain':
      return 'Status unknown';
    case 'succeeded':
      return 'Applied';
    case 'failed':
      return 'Load failed';
    case 'interrupted':
      return 'Stopped';
  }
};

const stateTone = (state: SkillActivityPresentationState): string => {
  if (state === 'failed') {
    return 'text-destructive';
  }
  if (state === 'succeeded') {
    return 'text-success';
  }
  if (state === 'running' || state === 'stopping') {
    return 'text-process';
  }
  return 'text-tertiary';
};

const StateIcon = ({
  state,
}: Readonly<{ state: SkillActivityPresentationState }>) => {
  switch (state) {
    case 'running':
    case 'stopping':
      return (
        <LoaderCircle
          className="size-3.5 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      );
    case 'succeeded':
      return <Check className="size-3.5" aria-hidden="true" />;
    case 'failed':
      return <X className="size-3.5" aria-hidden="true" />;
    case 'interrupted':
      return <Square className="size-3.5" aria-hidden="true" />;
    case 'uncertain':
      return <CircleHelp className="size-3.5" aria-hidden="true" />;
  }
};

export const SkillActivity = ({ activity, language }: SkillActivityProps) => {
  const copy = stateCopy(activity.state, language);
  const failed = activity.state === 'failed';

  return (
    <section
      className="my-1 flex min-w-0 items-center gap-3 rounded-xl border border-l-2 border-l-primary bg-surface px-3 py-2.5 shadow-sm"
      role={failed ? 'alert' : 'status'}
      aria-label={`${copy} Skill：${activity.name}`}
      data-state={activity.state}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background text-primary shadow-sm">
        <Sparkles className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-tertiary">
            Skill
          </span>
          <span className={`text-xs font-medium ${stateTone(activity.state)}`}>
            {copy}
          </span>
        </span>
        <strong className="mt-0.5 block truncate text-sm font-medium text-primary">
          {activity.name}
        </strong>
        {activity.errorKind ? (
          <span className="mt-0.5 block truncate font-mono text-[10px] text-destructive">
            {activity.errorKind}
          </span>
        ) : null}
      </span>
      <span
        className={`grid size-7 shrink-0 place-items-center rounded-full border bg-background ${stateTone(activity.state)}`}
        aria-hidden="true"
      >
        <StateIcon state={activity.state} />
      </span>
    </section>
  );
};
