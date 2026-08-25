import {
  Blocks,
  Folder,
  Import,
  LibraryBig,
  LoaderCircle,
  MessageSquare,
  Plus,
  Search,
  Settings,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { getKnowledge } from '@/renderer/services/knowledge';
import { getSkills, importSkill } from '@/renderer/services/skills';
import {
  activateWorkspaceChat,
  activateWorkspaceProject,
  focusWorkspaceTask,
  getWorkspaceState,
  selectWorkspace,
} from '@/renderer/services/workspace';
import type { KnowledgeBaseSummary } from '@/shared/knowledge';
import type { SkillSummary } from '@/shared/skills';
import type { WorkspaceStateSnapshot } from '@/shared/workspace';

import {
  parseRecentGlobalSearchItems,
  rankGlobalSearchCandidates,
  recordRecentGlobalSearchItem,
  type RecentGlobalSearchItems,
} from './global-search-model';

type GlobalSearchProps = Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenKnowledge: (knowledgeBaseId?: string) => void;
  onOpenSkills: (skillId?: string) => void;
  onOpenWorkbench: () => void;
  onOpenSettings: () => void;
}>;

type SearchGroup = '快捷操作' | '项目' | '聊天' | '知识库' | 'Skills';

type SearchItem = Readonly<{
  id: string;
  group: SearchGroup;
  label: string;
  description: string;
  keywords?: readonly string[];
  intrinsicRecencyMs?: number;
  icon: typeof Search;
  activate: () => void | Promise<void>;
}>;

const RECENT_STORAGE_KEY = 'sugarcode.desktop.global-search-recent.v1';
const GROUPS: readonly SearchGroup[] = ['快捷操作', '项目', '聊天', '知识库', 'Skills'];

const loadRecent = (): RecentGlobalSearchItems => {
  try {
    return parseRecentGlobalSearchItems(localStorage.getItem(RECENT_STORAGE_KEY));
  } catch {
    return {};
  }
};

export const GlobalSearch = ({
  open,
  onOpenChange,
  onOpenKnowledge,
  onOpenSkills,
  onOpenWorkbench,
  onOpenSettings,
}: GlobalSearchProps) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [workspace, setWorkspace] = useState<WorkspaceStateSnapshot>();
  const [knowledge, setKnowledge] = useState<readonly KnowledgeBaseSummary[]>([]);
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
  const [recent, setRecent] = useState<RecentGlobalSearchItems>(loadRecent);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const loadGeneration = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
      returnFocus.current?.focus();
      return;
    }
    returnFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const controller = new AbortController();
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoading(true);
    setLoadError(false);
    void Promise.allSettled([getWorkspaceState(), getKnowledge(), getSkills()]).then(
      ([workspaceResult, knowledgeResult, skillsResult]) => {
        if (controller.signal.aborted || loadGeneration.current !== generation) return;
        if (workspaceResult.status === 'fulfilled') setWorkspace(workspaceResult.value);
        if (knowledgeResult.status === 'fulfilled') {
          setKnowledge(knowledgeResult.value.knowledgeBases);
        }
        if (skillsResult.status === 'fulfilled') setSkills(skillsResult.value.skills);
        setLoadError(
          workspaceResult.status === 'rejected' &&
          knowledgeResult.status === 'rejected' &&
          skillsResult.status === 'rejected',
        );
        setLoading(false);
      },
    );
    return () => {
      controller.abort();
      loadGeneration.current += 1;
    };
  }, [open]);

  const items = useMemo<readonly SearchItem[]>(() => {
    const normalized = query.trim();
    const closeAnd = (operation: () => void | Promise<void>): (() => Promise<void>) =>
      async () => {
        onOpenChange(false);
        await operation();
      };
    const actions: SearchItem[] = [
      {
        id: 'action:settings', group: '快捷操作', label: '打开设置',
        description: '配置模型、外观和本地运行时', keywords: ['preferences', '检索设置'], icon: Settings,
        activate: closeAnd(onOpenSettings),
      },
      {
        id: 'action:new-chat', group: '快捷操作', label: '新建聊天',
        description: '开始一个不绑定项目的聊天', keywords: ['conversation'], icon: Plus,
        activate: closeAnd(async () => { await activateWorkspaceChat(); onOpenWorkbench(); }),
      },
      {
        id: 'action:open-project', group: '快捷操作', label: '打开项目',
        description: '选择一个本地项目目录', keywords: ['workspace', 'folder'], icon: Folder,
        activate: closeAnd(async () => { await selectWorkspace(); onOpenWorkbench(); }),
      },
      {
        id: 'action:knowledge', group: '快捷操作', label: '创建或管理知识库',
        description: '进入本地知识库', keywords: ['knowledge', '资料'], icon: LibraryBig,
        activate: closeAnd(() => onOpenKnowledge()),
      },
      {
        id: 'action:import-skill', group: '快捷操作', label: '导入 Skill',
        description: '从本地目录导入个人 Skill', keywords: ['capability'], icon: Import,
        activate: closeAnd(async () => { await importSkill(); onOpenSkills(); }),
      },
      {
        id: 'action:skills', group: '快捷操作', label: '打开能力中心',
        description: '管理技能与 MCP 工具连接', keywords: ['skill', 'mcp', 'import', 'export'], icon: Blocks,
        activate: closeAnd(() => onOpenSkills()),
      },
    ];
    const projects: SearchItem[] = (workspace?.projects ?? []).map((project) => ({
      id: `project:${project.id}`, group: '项目', label: project.name,
      description: `${project.threadIds.length} 个任务`, keywords: ['workspace'],
      intrinsicRecencyMs: project.lastOpenedAtMs, icon: Folder,
      activate: closeAnd(async () => { await activateWorkspaceProject(project.id); onOpenWorkbench(); }),
    }));
    const projectThreads = (workspace?.projects ?? []).flatMap((project) =>
      project.threadIds.map((threadId) => ({
        id: `thread:${threadId}`, group: '聊天' as const,
        label: project.threadTitles[threadId] ?? '未命名任务', description: project.name,
        keywords: ['task'], intrinsicRecencyMs: project.lastOpenedAtMs, icon: MessageSquare,
        activate: closeAnd(async () => {
          if (workspace.activeProjectId !== project.id) await activateWorkspaceProject(project.id);
          await focusWorkspaceTask(threadId); onOpenWorkbench();
        }),
      })),
    );
    const chats: SearchItem[] = (workspace?.chatThreadIds ?? []).map((threadId) => ({
      id: `chat:${threadId}`, group: '聊天',
      label: workspace?.chatTitles?.[threadId] ?? '未命名聊天', description: '普通聊天',
      keywords: ['conversation'], icon: MessageSquare,
      activate: closeAnd(async () => { await activateWorkspaceChat(threadId); onOpenWorkbench(); }),
    }));
    const knowledgeItems: SearchItem[] = knowledge.map((base) => ({
      id: `knowledge:${base.id}`, group: '知识库', label: base.name,
      description: base.description || `${base.documentCount} 个文档`, keywords: ['knowledge'], icon: LibraryBig,
      activate: closeAnd(() => onOpenKnowledge(base.id)),
    }));
    const skillItems: SearchItem[] = skills.map((skill) => ({
      id: `skill:${skill.id}`, group: 'Skills', label: skill.name,
      description: skill.description, keywords: ['skill', 'capability'], icon: Zap,
      activate: closeAnd(() => onOpenSkills(skill.id)),
    }));
    const visibleGroups = normalized
      ? [actions, projects, [...projectThreads, ...chats], knowledgeItems, skillItems]
      : [actions, projects, [...projectThreads, ...chats]];
    return visibleGroups.flatMap((group) =>
      rankGlobalSearchCandidates(group, normalized, recent).slice(0, normalized ? 7 : 5));
  }, [knowledge, onOpenChange, onOpenKnowledge, onOpenSettings, onOpenSkills, onOpenWorkbench, query, recent, skills, workspace]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(Math.max(0, items.length - 1));
    if (open && items.length > 0) {
      document.getElementById(`global-search-option-${Math.min(activeIndex, items.length - 1)}`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, items.length, open]);

  const activate = (item: SearchItem | undefined): void => {
    if (!item) return;
    setRecent((current) => {
      const next = recordRecentGlobalSearchItem(current, item.id);
      try { localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next)); } catch { /* best effort */ }
      return next;
    });
    void item.activate();
  };
  const grouped = GROUPS
    .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
    .filter((section) => section.items.length > 0);
  const activeItemId = items.length > 0 ? `global-search-option-${activeIndex}` : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12vh] max-w-2xl translate-y-0 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">搜索或运行</DialogTitle>
        <DialogDescription className="sr-only">搜索 SugarCode 页面、项目、聊天、知识库和 Skills</DialogDescription>
        <div className="relative border-b">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-tertiary" aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault(); setActiveIndex((index) => (index + 1) % Math.max(1, items.length));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault(); setActiveIndex((index) => (index - 1 + Math.max(1, items.length)) % Math.max(1, items.length));
              } else if (event.key === 'Home') {
                event.preventDefault(); setActiveIndex(0);
              } else if (event.key === 'End') {
                event.preventDefault(); setActiveIndex(Math.max(0, items.length - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault(); activate(items[activeIndex]);
              }
            }}
            autoFocus
            role="combobox"
            aria-expanded={open}
            aria-controls="global-search-results"
            aria-activedescendant={activeItemId}
            aria-autocomplete="list"
            placeholder="搜索项目、聊天、知识库、Skills 或命令…"
            className="h-14 rounded-none border-0 bg-transparent pl-11 pr-16 text-sm shadow-none focus-visible:ring-0"
          />
          <kbd className="absolute right-4 top-1/2 -translate-y-1/2 rounded border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-tertiary">ESC</kbd>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {loading ? '正在加载搜索项' : `找到 ${items.length} 个结果`}
        </p>
        <div id="global-search-results" role="listbox" aria-label="搜索结果" className="max-h-[30rem] overflow-y-auto p-2">
          {grouped.map((section) => (
            <section key={section.group} aria-labelledby={`global-search-group-${section.group}`}>
              <p id={`global-search-group-${section.group}`} className="px-2.5 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-tertiary">{section.group}</p>
              {section.items.map((item) => {
                const index = items.indexOf(item);
                const Icon = item.icon;
                return (
                  <Button
                    key={item.id}
                    id={`global-search-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    variant="ghost"
                    className={`h-auto w-full justify-start gap-3 rounded-xl px-3 py-2.5 text-left ${index === activeIndex ? 'bg-brand/10 text-brand' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => activate(item)}
                  >
                    <span className="grid size-8 place-items-center rounded-lg border bg-background"><Icon className="size-4" aria-hidden="true" /></span>
                    <span className="min-w-0"><span className="block truncate text-sm font-medium">{item.label}</span><span className="mt-0.5 block truncate text-xs font-normal text-secondary">{item.description}</span></span>
                  </Button>
                );
              })}
            </section>
          ))}
          {loading ? (
            <p className="flex items-center justify-center gap-2 px-3 py-5 text-xs text-tertiary"><LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />正在刷新本地项目和能力…</p>
          ) : null}
          {loadError ? <p className="px-3 py-4 text-center text-xs text-destructive" role="alert">无法刷新搜索数据，仍可使用快捷操作。</p> : null}
          {!loading && items.length === 0 ? <p className="px-3 py-10 text-center text-sm text-tertiary">没有匹配的结果</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};
