import {
  ArrowRight,
  Code2,
  FileSearch,
  Folder,
  Lightbulb,
  ListChecks,
  MessagesSquare,
  SearchCode,
  Wrench,
} from 'lucide-react';

import appIcon from '../../../../assets/icon.png';

const PROJECT_STARTERS = [
  {
    icon: FileSearch,
    title: '快速了解这个项目',
    description: '结构、技术栈与核心流程',
    prompt:
      '请快速分析当前项目的结构、技术栈和核心流程，并告诉我应该从哪里开始。',
  },
  {
    icon: Wrench,
    title: '修复一个问题',
    description: '定位原因并完成验证',
    prompt: '请帮我定位并修复这个问题：\n\n',
  },
  {
    icon: Code2,
    title: '实现一个需求',
    description: '理解现状后直接完成改动',
    prompt: '请帮我实现这个需求：\n\n',
  },
  {
    icon: ListChecks,
    title: '审查当前改动',
    description: '检查缺陷、风险和遗漏',
    prompt:
      '/review 请审查当前工作区的改动，优先指出缺陷、风险和缺失的测试。',
  },
] as const;

const CHAT_STARTERS = [
  {
    icon: Lightbulb,
    title: '展开一个想法',
    description: '一起厘清目标和可能性',
    prompt: '我有一个想法，请帮我一起梳理：\n\n',
  },
  {
    icon: SearchCode,
    title: '分析一个问题',
    description: '找到关键因素和解决路径',
    prompt: '请帮我分析这个问题，并给出清晰的解决思路：\n\n',
  },
  {
    icon: MessagesSquare,
    title: '解释一段内容',
    description: '用简单准确的方式说明',
    prompt: '请帮我解释下面的内容：\n\n',
  },
  {
    icon: ListChecks,
    title: '制定行动计划',
    description: '把目标拆成可执行步骤',
    prompt: '请把下面的目标拆解成一份清晰、可执行的行动计划：\n\n',
  },
] as const;

type EmptyThreadStateProps = Readonly<{
  onSelectPrompt: (prompt: string) => void;
  projectName?: string;
}>;

export const EmptyThreadState = ({
  onSelectPrompt,
  projectName,
}: EmptyThreadStateProps) => {
  const starters = projectName ? PROJECT_STARTERS : CHAT_STARTERS;

  return (
    <section
      className="empty-thread-stage my-auto py-10 sm:py-14"
      aria-labelledby="empty-thread-title"
    >
      <div className="mx-auto max-w-xl">
        <div className="empty-thread-brand empty-thread-intro flex items-center gap-2.5 text-xs font-normal text-tertiary">
          <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-[10px] border bg-white shadow-sm dark:border-white/10 dark:bg-white/90">
            <img src={appIcon} alt="" className="size-7" aria-hidden="true" />
          </span>
          <span className="font-medium text-secondary">SugarCode</span>
          <span className="text-border" aria-hidden="true">
            /
          </span>
          {projectName ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <Folder className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{projectName}</span>
            </span>
          ) : (
            <span>新对话</span>
          )}
        </div>

        <div className="empty-thread-intro empty-thread-intro--title mt-7">
          <h1
            id="empty-thread-title"
            className="empty-thread-heading text-[2rem] font-medium leading-tight tracking-[-0.045em] sm:text-[2.25rem]"
          >
            今天想推进什么？
          </h1>
          <p className="empty-thread-subtitle mt-2.5 text-sm font-normal leading-6 text-secondary">
            直接描述目标，或者从一个常用动作开始。
          </p>
        </div>

        <div className="empty-thread-intro empty-thread-intro--actions mt-8">
          <div className="empty-thread-actions-header mb-2.5 flex items-center justify-between px-1">
            <p className="text-[11px] font-medium text-tertiary">快速开始</p>
            <p className="text-[11px] font-normal text-tertiary">
              点击后可继续编辑
            </p>
          </div>
          <div className="empty-thread-actions overflow-hidden rounded-2xl border bg-background">
            {starters.map((starter, index) => {
              const Icon = starter.icon;
              return (
                <button
                  key={starter.title}
                  type="button"
                  className="empty-thread-action group flex min-h-14 w-full items-center gap-3 border-b px-3.5 text-left transition-colors last:border-b-0 hover:bg-surface focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelectPrompt(starter.prompt)}
                  aria-label={`${starter.title}：${starter.description}`}
                >
                  <span className="empty-thread-action-index w-5 shrink-0 font-mono text-[10px] font-normal tabular-nums text-tertiary">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <Icon
                    className="size-4 shrink-0 text-tertiary transition-colors group-hover:text-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium tracking-[-0.01em]">
                      {starter.title}
                    </span>
                    <span className="empty-thread-action-description mt-0.5 block truncate text-xs font-normal text-tertiary">
                      {starter.description}
                    </span>
                  </span>
                  <ArrowRight
                    className="empty-thread-action-arrow size-3.5 shrink-0 -translate-x-1 text-tertiary opacity-0 transition-[transform,opacity] group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </div>

        <p className="empty-thread-hint empty-thread-intro empty-thread-intro--hint mt-4 px-1 text-[11px] font-normal text-tertiary">
          输入 <kbd className="font-mono text-secondary">@</kbd> 引用文件，
          <kbd className="font-mono text-secondary">$</kbd> 调用 Skill，或使用
          <kbd className="font-mono text-secondary"> / </kbd>命令。
        </p>
      </div>
    </section>
  );
};
