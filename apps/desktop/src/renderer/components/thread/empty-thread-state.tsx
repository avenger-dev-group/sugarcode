import { Code2, Lightbulb, SearchCode } from 'lucide-react';

import appIcon from '../../../../assets/icon.png';

export const EmptyThreadState = () => (
  <section className="my-auto py-12" aria-labelledby="empty-thread-title">
    <div className="mx-auto max-w-xl">
      <div className="flex items-center gap-3">
        <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-2xl border bg-surface shadow-sm">
          <img src={appIcon} alt="" className="size-10" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-medium">SugarCode</p>
          <p className="text-sm font-normal text-secondary">
            你的本地开发搭档
          </p>
        </div>
      </div>

      <h1
        id="empty-thread-title"
        className="mt-8 max-w-lg text-[2rem] font-medium leading-[1.15] tracking-[-0.04em]"
      >
        今天想完成什么？
      </h1>
      <p className="mt-3 max-w-lg text-sm font-normal leading-[22px] text-secondary">
        告诉 SugarCode 你的目标、遇到的问题或手头的想法，它会结合当前上下文，和你一起把事情向前推进。
      </p>

      <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-3">
        <article className="bg-background p-4">
          <SearchCode className="size-4 text-tertiary" aria-hidden="true" />
          <h2 className="mt-3 text-sm font-medium">理解项目</h2>
          <p className="mt-1 text-sm font-normal leading-normal text-secondary">
            梳理结构、定位问题与风险
          </p>
        </article>
        <article className="bg-background p-4">
          <Code2 className="size-4 text-tertiary" aria-hidden="true" />
          <h2 className="mt-3 text-sm font-medium">完成改动</h2>
          <p className="mt-1 text-sm font-normal leading-normal text-secondary">
            实现功能、修复问题并验证
          </p>
        </article>
        <article className="bg-background p-4">
          <Lightbulb className="size-4 text-tertiary" aria-hidden="true" />
          <h2 className="mt-3 text-sm font-medium">展开想法</h2>
          <p className="mt-1 text-sm font-normal leading-normal text-secondary">
            形成方案、文档或交付物
          </p>
        </article>
      </div>
    </div>
  </section>
);
