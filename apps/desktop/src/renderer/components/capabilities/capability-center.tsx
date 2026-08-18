import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileText,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Store,
  Wrench,
} from 'lucide-react';

import { AgentMarkdown } from '@/renderer/components/agent/agent-markdown';
import { MainSurfaceHeader } from '@/renderer/components/foundation/main-surface-header';
import { SkillsSettingsPanel } from '@/renderer/components/skills/skills-settings-panel';
import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { getSkills, installCuratedSkill } from '@/renderer/services/skills';
import {
  CURATED_SKILL_CATEGORIES,
  CURATED_SKILLS,
  curatedSkillMatches,
  type CuratedSkill,
  type CuratedSkillCategory,
} from '@/shared/skill-market';
import type { SkillSummary } from '@/shared/skills';

type SkillTab = 'featured' | 'installed';
type CategoryFilter = 'all' | CuratedSkillCategory;

const FeaturedCard = ({
  entry,
  installed,
  pending,
  onInstall,
  onOpen,
}: Readonly<{
  entry: CuratedSkill;
  installed?: SkillSummary;
  pending: boolean;
  onInstall: (entry: CuratedSkill) => void;
  onOpen: (entry: CuratedSkill) => void;
}>) => {
  const matchesCatalog = installed?.sha256 === entry.skillSha256;
  return (
    <article className="flex min-h-52 flex-col rounded-2xl border bg-background p-5 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
          <ShieldCheck className="size-4.5" aria-hidden="true" />
        </span>
        <span className="rounded-full border bg-surface px-2 py-1 text-[10px] font-medium text-secondary">
          {entry.version}
        </span>
      </div>
      <h2 className="mt-4 text-sm font-semibold tracking-[-0.01em]">{entry.name}</h2>
      <p className="mt-1.5 flex-1 text-xs leading-5 text-secondary">{entry.description}</p>
      <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
        <Button type="button" variant="ghost" size="sm" onClick={() => onOpen(entry)}>
          <FileText aria-hidden="true" />详情
        </Button>
        {matchesCatalog ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-secondary">
            <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden="true" />已安装
          </span>
        ) : installed ? (
          <span className="text-xs font-medium text-secondary" title="精选安装不会覆盖同名 Skill">
            同名 Skill 已存在
          </span>
        ) : (
          <Button size="sm" disabled={pending} onClick={() => onInstall(entry)}>
            {pending ? <RefreshCw className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
            {pending ? '校验中' : '安装'}
          </Button>
        )}
      </div>
    </article>
  );
};

export const SkillsCenter = ({
  initialSkillId,
  onInitialSkillHandled,
}: Readonly<{
  initialSkillId?: string;
  onInitialSkillHandled?: () => void;
}> = {}) => {
  const [tab, setTab] = useState<SkillTab>('featured');
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
  const [pendingId, setPendingId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [selectedEntry, setSelectedEntry] = useState<CuratedSkill>();

  const refresh = useCallback(async () => {
    try {
      setSkills((await getSkills()).skills);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法读取已安装 Skills。');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (initialSkillId) setTab('installed');
  }, [initialSkillId]);

  const installedByName = useMemo(
    () => new Map(skills.map((skill) => [skill.name, skill])),
    [skills],
  );
  const visibleEntries = useMemo(
    () => CURATED_SKILLS.filter((entry) =>
      (category === 'all' || entry.category === category) && curatedSkillMatches(entry, query)),
    [category, query],
  );

  const install = async (entry: CuratedSkill) => {
    setPendingId(entry.id);
    setMessage(undefined);
    try {
      const result = await installCuratedSkill(entry.id);
      if (result.accepted === false) {
        setMessage(result.message ?? '安装没有完成。');
        return;
      }
      setSkills(result.inspection?.skills ?? (await getSkills()).skills);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '安装没有完成。');
    } finally {
      setPendingId(undefined);
    }
  };

  const tabs: readonly Readonly<{
    id: SkillTab;
    label: string;
    icon: typeof Store;
    count: number;
  }>[] = [
    { id: 'featured', label: '精选 Skills', icon: Store, count: CURATED_SKILLS.length },
    { id: 'installed', label: '已安装', icon: Wrench, count: skills.length },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <MainSurfaceHeader
        icon={<Sparkles className="size-5" aria-hidden="true" />}
        title="技能"
        description="从 SugarCode 精选目录安装 Skills，或管理本地导入的能力。安装前会固定版本并校验完整目录哈希。"
      >
        <div className="window-no-drag mt-5 flex w-fit gap-1 rounded-xl border bg-surface/60 p-1" role="tablist" aria-label="技能页面">
          {tabs.map(({ id, label, icon: Icon, count }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={tab === id
                ? 'flex h-8 items-center gap-2 rounded-lg border border-brand/25 bg-brand/10 px-3 text-sm font-medium text-brand'
                : 'flex h-8 items-center gap-2 rounded-lg px-3 text-sm text-secondary hover:bg-background/70 hover:text-foreground'}
            >
              <Icon className="size-3.5" aria-hidden="true" />{label}
              <span className="min-w-4 rounded bg-surface px-1 text-center text-[10px] text-tertiary">{count}</span>
            </button>
          ))}
        </div>
      </MainSurfaceHeader>

      {message ? (
        <div className="mx-6 mt-4 rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-xs text-amber-700 sm:mx-8" role="status">
          {message}
        </div>
      ) : null}

      {tab === 'installed' ? (
        <div className="min-h-0 flex-1">
          <SkillsSettingsPanel
            active
            initialSkillId={initialSkillId}
            onInitialSkillHandled={onInitialSkillHandled}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Skill 分类">
              <Button type="button" size="sm" variant={category === 'all' ? 'default' : 'outline'} onClick={() => setCategory('all')}>
                全部
              </Button>
              {CURATED_SKILL_CATEGORIES.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  size="sm"
                  variant={category === item.id ? 'default' : 'outline'}
                  title={item.description}
                  onClick={() => setCategory(item.id)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <div className="relative w-full lg:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary" aria-hidden="true" />
              <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索精选 Skill" aria-label="搜索精选 Skill" className="pl-9" />
            </div>
          </div>
          <p className="mb-4 text-xs text-tertiary">
            目录随应用提供，离线可浏览；安装时从固定提交下载并校验。共 {visibleEntries.length} 项。
          </p>
          {visibleEntries.length > 0 ? (
            <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
              {visibleEntries.map((entry) => (
                <FeaturedCard
                  key={entry.id}
                  entry={entry}
                  installed={installedByName.get(entry.name)}
                  pending={pendingId === entry.id}
                  onOpen={setSelectedEntry}
                  onInstall={(value) => void install(value)}
                />
              ))}
            </div>
          ) : (
            <div className="grid min-h-48 place-items-center rounded-2xl border border-dashed text-sm text-tertiary" role="status">
              没有匹配的精选 Skill
            </div>
          )}
        </div>
      )}

      <Dialog open={Boolean(selectedEntry)} onOpenChange={(open) => { if (!open) setSelectedEntry(undefined); }}>
        <DialogContent className="flex max-h-[82vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
          {selectedEntry ? (
            <>
              <header className="shrink-0 border-b px-6 py-5">
                <DialogTitle className="text-base">{selectedEntry.name}</DialogTitle>
                <DialogDescription className="mt-1.5 leading-5">{selectedEntry.description}</DialogDescription>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-tertiary">
                  <span className="rounded-md border bg-surface px-2 py-1">版本 {selectedEntry.version}</span>
                  <span className="rounded-md border bg-surface px-2 py-1">{selectedEntry.license}</span>
                  <span className="rounded-md border bg-surface px-2 py-1">最低 SugarCode {selectedEntry.minimumAppVersion}</span>
                </div>
              </header>
              <ScrollArea className="min-h-0 flex-1">
                <div className="grid gap-6 px-6 py-5 md:grid-cols-[minmax(0,1fr)_13rem]">
                  <section aria-labelledby="curated-preview-heading">
                    <h3 id="curated-preview-heading" className="mb-3 text-sm font-medium">SKILL.md 内容预览</h3>
                    <AgentMarkdown source={selectedEntry.preview} isStreaming={false} />
                  </section>
                  <aside>
                    <h3 className="mb-3 text-sm font-medium">目录文件</h3>
                    <ul className="space-y-2">
                      {selectedEntry.files.map((file) => (
                        <li key={file} className="break-all rounded-lg border bg-surface px-3 py-2 font-mono text-[11px] text-secondary">{file}</li>
                      ))}
                    </ul>
                    <p className="mt-4 text-xs leading-5 text-tertiary">作者：{selectedEntry.author}</p>
                  </aside>
                </div>
              </ScrollArea>
              <footer className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-4">
                <Button type="button" variant="outline" onClick={() => setSelectedEntry(undefined)}>关闭</Button>
                {installedByName.has(selectedEntry.name) ? null : (
                  <Button type="button" disabled={pendingId === selectedEntry.id} onClick={() => void install(selectedEntry)}>
                    {pendingId === selectedEntry.id ? <RefreshCw className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                    安装
                  </Button>
                )}
              </footer>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
};
