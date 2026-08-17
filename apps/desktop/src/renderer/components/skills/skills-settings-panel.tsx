import {
  Check,
  CircleAlert,
  Download,
  FileText,
  FolderDown,
  RefreshCw,
  Sparkles,
  Upload,
  UserRound,
  X,
} from 'lucide-react';

import { AgentMarkdown } from '@/renderer/components/agent/agent-markdown';
import { Button } from '@/renderer/components/ui/button';
import { Checkbox } from '@/renderer/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/renderer/components/ui/popover';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';

import type { SkillsSettingsPanelProps } from './types';
import { useStore } from './use-store';

export const SkillsSettingsPanel = ({ active }: SkillsSettingsPanelProps) => {
  const store = useStore(active);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b px-6 py-4">
        <Sparkles className="size-4 text-secondary" aria-hidden="true" />
        <h2 className="text-sm font-medium">技能</h2>
        <div className="ml-auto flex items-center gap-2">
          <Popover
            open={store.importMenuOpen}
            onOpenChange={store.setImportMenuOpen}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                disabled={store.actionPending}
              >
                <Upload aria-hidden="true" />
                导入目录
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-1.5">
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start px-2.5 py-2 text-left"
                onClick={() => void store.importDirectory('user')}
              >
                <UserRound aria-hidden="true" />
                <span>
                  <span className="block text-sm">个人 Skills</span>
                  <span className="block text-xs font-normal text-tertiary">
                    在所有项目中可用
                  </span>
                </span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start px-2.5 py-2 text-left"
                disabled={!store.workspaceAvailable}
                onClick={() => void store.importDirectory('project')}
              >
                <FolderDown aria-hidden="true" />
                <span>
                  <span className="block text-sm">当前项目</span>
                  <span className="block text-xs font-normal text-tertiary">
                    只在当前项目中可用
                  </span>
                </span>
              </Button>
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="outline"
            disabled={store.status === 'loading' || store.actionPending}
            onClick={() => void store.refresh()}
          >
            <RefreshCw
              className={
                store.status === 'loading' ? 'animate-spin' : undefined
              }
              aria-hidden="true"
            />
            刷新扫描
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-6">
          <p className="mb-4 max-w-2xl text-sm font-normal leading-[22px] text-secondary">
            启用后，SugarCode 会根据名称和说明判断 Skill 是否适用并按需加载；
            也可以在提问中使用{' '}
            <code className="font-mono text-xs">$skill-name</code> 明确选择。
          </p>

          {store.status === 'loading' && store.skills.length === 0 ? (
            <div
              className="flex min-h-48 items-center justify-center gap-2 text-sm text-process"
              role="status"
            >
              <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
              正在扫描 Skills…
            </div>
          ) : null}

          {store.status !== 'loading' && store.skills.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center">
              <span className="grid size-10 place-items-center rounded-xl bg-surface text-tertiary">
                <Sparkles className="size-5" aria-hidden="true" />
              </span>
              <p className="mt-3 text-sm font-medium">未发现 Skill</p>
              <p className="mt-1 max-w-md text-sm font-normal leading-normal text-secondary">
                可导入包含 SKILL.md 的目录，或放入个人 Skills、项目的
                .sugarcode/skills、.agents/skills、.claude/skills。
              </p>
            </div>
          ) : null}

          {store.skills.length > 0 ? (
            <div className="space-y-2" aria-label="Skills 列表">
              {store.skills.map((skill) => (
                <div
                  key={skill.id}
                  className={`group flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors ${
                    store.selectedSkill?.id === skill.id
                      ? 'border-input bg-surface'
                      : 'bg-background hover:bg-surface'
                  }`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => void store.openSkill(skill)}
                    aria-label={`查看 ${skill.name} 的 SKILL.md`}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-surface text-tertiary transition-colors group-hover:text-secondary">
                      <FileText className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {skill.name}
                      </span>
                      <span className="mt-0.5 block truncate text-xs font-normal leading-4 text-secondary">
                        {skill.description || '未提供说明'}
                      </span>
                    </span>
                    <span className="hidden shrink-0 rounded-md bg-surface px-2 py-1 font-mono text-[10px] text-tertiary sm:block">
                      {skill.source === 'project' ? '项目' : '个人'}
                    </span>
                  </button>
                  <Checkbox
                    checked={skill.enabled}
                    disabled={store.actionPending}
                    aria-label={`${skill.enabled ? '停用' : '启用'} ${skill.name}`}
                    onCheckedChange={() => void store.toggle(skill)}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {store.error ? (
            <div
              className="mt-3 flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm font-normal leading-normal text-destructive"
              role="alert"
            >
              <CircleAlert
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
              {store.error}
            </div>
          ) : null}
          {store.notice ? (
            <div
              className="mt-3 flex items-start gap-2.5 rounded-lg border border-success/30 bg-success/5 px-3.5 py-3 text-sm font-normal leading-normal text-success"
              role="status"
            >
              <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="break-all">{store.notice}</span>
            </div>
          ) : null}
        </div>
      </ScrollArea>

      {store.selectedSkill ? (
        <>
          <button
            type="button"
            className="absolute inset-0 z-10 cursor-default bg-background/50 backdrop-blur-[1px]"
            onClick={store.closeSkill}
            aria-label="关闭 Skill 详情"
          />
          <aside
            ref={store.detailRef}
            className="absolute inset-y-0 right-0 z-20 flex w-[min(32.5rem,100%)] flex-col border-l bg-background shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="skill-detail-title"
          >
            <header className="flex shrink-0 items-center gap-3 border-b px-5 py-4">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-surface text-tertiary">
                <FileText className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <strong
                  id="skill-detail-title"
                  className="block truncate text-sm font-medium"
                >
                  {store.selectedSkill.name}
                </strong>
                <small className="mt-0.5 block truncate font-mono text-[10px] text-tertiary">
                  {store.selectedSkill.path}
                </small>
              </span>
              <Button
                type="button"
                variant="ghost"
                disabled={store.actionPending}
                onClick={() => {
                  if (store.selectedSkill) {
                    void store.exportDirectory(store.selectedSkill);
                  }
                }}
              >
                <Download aria-hidden="true" />
                导出
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                ref={store.closeButtonRef}
                onClick={store.closeSkill}
                aria-label="关闭 Skill 内容"
              >
                <X aria-hidden="true" />
              </Button>
            </header>
            <ScrollArea
              className="min-h-0 flex-1"
              scrollbars="both"
              viewportProps={{
                'aria-label': 'Skill 内容预览',
                className: '[&>div]:min-w-full',
              }}
            >
              <div className="min-w-full px-6 pt-5 pb-7">
                {store.contentLoading ? (
                  <div
                    className="flex min-h-40 items-center justify-center gap-2 text-sm text-process"
                    role="status"
                  >
                    <RefreshCw
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                    正在读取 SKILL.md…
                  </div>
                ) : null}
                {store.contentError ? (
                  <div
                    className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm text-destructive"
                    role="alert"
                  >
                    <CircleAlert
                      className="mt-0.5 size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    {store.contentError}
                  </div>
                ) : null}
                {store.content ? (
                  <AgentMarkdown
                    source={store.content.content}
                    isStreaming={false}
                  />
                ) : null}
              </div>
            </ScrollArea>
          </aside>
        </>
      ) : null}
    </div>
  );
};
