import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Download,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Store,
  Wrench,
} from 'lucide-react';

import { MainSurfaceHeader } from '@/renderer/components/foundation/main-surface-header';
import { SkillsSettingsPanel } from '@/renderer/components/skills/skills-settings-panel';
import { Button } from '@/renderer/components/ui/button';
import { getSkills, installCuratedSkill } from '@/renderer/services/skills';
import { CURATED_SKILLS, type CuratedSkill } from '@/shared/skill-market';
import type { SkillSummary } from '@/shared/skills';

type SkillTab = 'featured' | 'installed' | 'updates';

const FeaturedCard = ({
  entry,
  installed,
  pending,
  onInstall,
}: Readonly<{
  entry: CuratedSkill;
  installed?: SkillSummary;
  pending: boolean;
  onInstall: (entry: CuratedSkill) => void;
}>) => {
  const matchesCatalog = installed?.sha256 === entry.skillSha256;
  return (
    <article className="flex min-h-48 flex-col rounded-2xl border bg-background p-5 shadow-xs">
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
        <span className="text-[11px] text-tertiary">{entry.author} · {entry.license}</span>
        {matchesCatalog ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-secondary">
            <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden="true" />已安装
          </span>
        ) : installed ? (
          <span className="text-xs font-medium text-amber-600" title="为保护本地修改，精选安装不会覆盖同名 Skill">
            已本地修改
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

export const SkillsCenter = () => {
  const [tab, setTab] = useState<SkillTab>('featured');
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
  const [pendingId, setPendingId] = useState<string>();
  const [message, setMessage] = useState<string>();

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

  const installedByName = useMemo(
    () => new Map(skills.map((skill) => [skill.name, skill])),
    [skills],
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
    { id: 'updates', label: '可更新', icon: RefreshCw, count: 0 },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <MainSurfaceHeader
        icon={<Sparkles className="size-5" aria-hidden="true" />}
        title="技能"
        description="从 SugarCode 精选目录安装 Skills，或管理本地导入的能力。安装前会固定版本并校验完整目录哈希。"
      >
        <div className="window-no-drag mt-5 flex w-fit gap-1 rounded-xl border bg-surface/60 p-1" role="tablist" aria-label="技能分类">
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
        <div className="mx-6 mt-4 rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-xs text-amber-700 sm:mx-8">
          {message}
        </div>
      ) : null}

      {tab === 'installed' ? (
        <div className="min-h-0 flex-1"><SkillsSettingsPanel active /></div>
      ) : tab === 'featured' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium">工程质量</h2>
              <p className="mt-1 text-xs text-tertiary">目录随应用提供，离线可浏览；安装时从固定提交下载并校验。</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw aria-hidden="true" />刷新状态
            </Button>
          </div>
          <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            {CURATED_SKILLS.map((entry) => (
              <FeaturedCard
                key={entry.id}
                entry={entry}
                installed={installedByName.get(entry.name)}
                pending={pendingId === entry.id}
                onInstall={(value) => void install(value)}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
          <div className="max-w-sm">
            <span className="mx-auto grid size-11 place-items-center rounded-2xl border bg-surface">
              <CheckCircle2 className="size-5 text-secondary" aria-hidden="true" />
            </span>
            <h2 className="mt-4 text-sm font-medium">所有精选 Skills 均为当前版本</h2>
            <p className="mt-1.5 text-xs leading-5 text-tertiary">SugarCode 只检查更新，不会自动下载或覆盖本地内容。</p>
          </div>
        </div>
      )}
    </div>
  );
};
