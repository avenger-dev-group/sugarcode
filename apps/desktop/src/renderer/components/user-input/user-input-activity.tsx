import { ChevronDown, CircleHelp } from 'lucide-react';

import type { ProcessLanguage } from '@/renderer/components/thread/types';

import type { UserInputActivityViewModel } from './types';

const summary = (
  activity: UserInputActivityViewModel,
  language: ProcessLanguage,
): string => {
  if (language === 'zh') {
    switch (activity.state) {
      case 'awaiting':
        return `已询问 ${activity.questions.length} 个问题 · 等待你的回答`;
      case 'submitted':
        return `已询问 ${activity.questions.length} 个问题`;
      case 'cancelled':
        return '问题已取消';
      case 'interrupted':
        return '未回答（任务已中断）';
    }
  }
  switch (activity.state) {
    case 'awaiting':
      return `Asked ${activity.questions.length} questions · Waiting for your answers`;
    case 'submitted':
      return `Asked ${activity.questions.length} questions`;
    case 'cancelled':
      return 'Questions cancelled';
    case 'interrupted':
      return 'Unanswered (task interrupted)';
  }
};

const unanswered = (
  state: UserInputActivityViewModel['state'],
  language: ProcessLanguage,
): string => {
  if (language === 'zh') {
    if (state === 'awaiting') return '等待回答';
    if (state === 'cancelled') return '未回答（已取消）';
    if (state === 'interrupted') return '未回答（任务已中断）';
    return '未回答';
  }
  if (state === 'awaiting') return 'Waiting for an answer';
  if (state === 'cancelled') return 'Unanswered (cancelled)';
  if (state === 'interrupted') return 'Unanswered (task interrupted)';
  return 'Unanswered';
};

export const UserInputActivity = ({
  activity,
  language,
}: Readonly<{
  activity: UserInputActivityViewModel;
  language: ProcessLanguage;
}>) => {
  const decisionByQuestion = new Map(
    activity.decisions.map((decision) => [decision.questionId, decision]),
  );
  const label = summary(activity, language);

  return (
    <details
      className="group/user-input min-w-0 rounded-lg border border-border-subtle bg-background"
      aria-label={label}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm text-secondary outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <CircleHelp
          className={`size-3.5 shrink-0 ${activity.state === 'awaiting' ? 'text-process' : 'text-tertiary'}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">{label}</span>
        <ChevronDown
          className="size-3.5 shrink-0 text-tertiary transition-transform group-open/user-input:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-3 border-t border-border-subtle px-3 py-3">
        {activity.questions.map((question, index) => {
          const decision = decisionByQuestion.get(question.id);
          const answer = decision?.kind === 'answered'
            ? decision.answer
            : decision?.kind === 'skipped'
              ? language === 'zh' ? '已跳过' : 'Skipped'
              : unanswered(activity.state, language);
          return (
            <div key={question.id} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2">
              <span className="text-xs tabular-nums text-tertiary">{index + 1}.</span>
              <div className="min-w-0">
                <p className="text-xs leading-relaxed text-secondary">
                  {question.question}
                </p>
                <p className="mt-1 break-words text-sm leading-relaxed text-primary">
                  {answer}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
};
