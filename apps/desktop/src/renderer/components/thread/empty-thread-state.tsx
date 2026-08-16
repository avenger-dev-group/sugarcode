import {
  ArrowUpRight,
  Code2,
  FileSearch,
  Lightbulb,
  ListChecks,
  MessagesSquare,
  SearchCode,
  Wrench,
} from 'lucide-react';

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
    prompt:
      '/plan 请把下面的目标拆解成一份清晰、可执行的行动计划：\n\n',
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
      className="empty-thread-stage relative mx-auto min-h-full w-full max-w-3xl"
      aria-labelledby="empty-thread-title"
    >
      <div className="empty-thread-glow" aria-hidden="true" />

      <header className="empty-thread-hero empty-thread-intro relative z-[1] text-center">
        <h1
          id="empty-thread-title"
          className="empty-thread-heading text-[2rem] font-medium leading-tight tracking-[-0.045em] sm:text-[2.35rem]"
        >
          今天想推进什么？
        </h1>
        <p className="empty-thread-subtitle mx-auto mt-2 max-w-lg text-sm font-normal leading-6 text-secondary">
          描述目标，SugarCode 会理解上下文、执行工作并验证结果。
        </p>
      </header>

      <div className="empty-thread-composer-space" aria-hidden="true" />

      <div className="empty-thread-starters empty-thread-intro empty-thread-intro--actions relative z-[1]">
        <div className="empty-thread-actions-header mb-2.5 flex items-center justify-between px-1">
          <p className="text-[11px] font-medium text-tertiary">或者，从这里开始</p>
          <p className="text-[11px] font-normal text-tertiary">选择后仍可编辑</p>
        </div>
        <div className="empty-thread-actions grid grid-cols-2 gap-2.5">
          {starters.map((starter) => {
            const Icon = starter.icon;
            return (
              <button
                key={starter.title}
                type="button"
                className="empty-thread-action group flex min-h-[4.5rem] w-full items-center gap-3 rounded-2xl border bg-background/80 px-3.5 text-left shadow-sm backdrop-blur-sm transition-[border-color,background-color,box-shadow,transform] hover:-translate-y-px hover:border-input hover:bg-background hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelectPrompt(starter.prompt)}
                aria-label={`${starter.title}：${starter.description}`}
              >
                <span className="empty-thread-action-icon grid size-9 shrink-0 place-items-center rounded-xl bg-surface">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium tracking-[-0.01em]">
                    {starter.title}
                  </span>
                  <span className="empty-thread-action-description mt-0.5 block truncate text-xs font-normal text-tertiary">
                    {starter.description}
                  </span>
                </span>
                <ArrowUpRight
                  className="empty-thread-action-arrow size-3.5 shrink-0 text-tertiary opacity-0 transition-[transform,opacity] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100"
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
        <p className="empty-thread-hint empty-thread-intro empty-thread-intro--hint mt-3 text-center text-[11px] font-normal text-tertiary">
          <kbd className="font-mono text-secondary">@</kbd> 引用文件
          <span className="mx-2 text-border">·</span>
          <kbd className="font-mono text-secondary">$</kbd> 调用 Skill
          <span className="mx-2 text-border">·</span>
          <kbd className="font-mono text-secondary">/</kbd> 使用命令
        </p>
      </div>
    </section>
  );
};
