import {
  AlertCircle,
  ArrowLeft,
  BookOpenText,
  Check,
  Database,
  Download,
  FileStack,
  FilePlus2,
  FileText,
  FolderPlus,
  HardDrive,
  LibraryBig,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { MainSurfaceHeader } from '@/renderer/components/foundation/main-surface-header';
import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { Textarea } from '@/renderer/components/ui/textarea';
import {
  addKnowledgeFiles,
  addKnowledgeFolder,
  cancelKnowledgeIndexJob,
  cancelSemanticModelDownload,
  createKnowledgeBase,
  createKnowledgeTextDocument,
  deleteKnowledgeSource,
  deleteKnowledgeBase,
  getKnowledge,
  getKnowledgeBaseDetail,
  installSemanticModel,
  readKnowledgeTextDocument,
  removeSemanticModel,
  selectKnowledgeRetrievalPlan,
  setSemanticIndexPaused,
  rescanKnowledgeSource,
  searchKnowledge,
  updateKnowledgeBase,
  updateKnowledgeTextDocument,
} from '@/renderer/services/knowledge';
import type {
  KnowledgeActionResult,
  KnowledgeBaseDetail,
  KnowledgeBaseSummary,
  KnowledgeEditableDocument,
  KnowledgeInspection,
  KnowledgeSearchResult,
  KnowledgeUpdateRequest,
} from '@/shared/knowledge';

type DetailTab = 'overview' | 'content' | 'search' | 'settings';
type SourceChoice = 'none' | 'files' | 'folder';

const EMPTY_INSPECTION: KnowledgeInspection = {
  knowledgeBases: [],
  semanticModel: {
    state: 'notInstalled',
    enabled: false,
    modelId: 'intfloat/multilingual-e5-small',
    version: '2026-04-02',
    revision: '614241f622f53c4eeff9890bdc4f31cfecc418b3',
    dimensions: 384,
    runtime: 'ONNX Runtime CPU',
    variant: 'INT8 优化',
    downloadedBytes: 0,
    totalBytes: 135_392_178,
    installedBytes: 0,
    semanticIndex: {
      state: 'notIndexed',
      indexedChunks: 0,
      totalChunks: 0,
      errorCount: 0,
    },
    device: {
      architecture: 'unknown',
      logicalCores: 0,
      totalMemoryBytes: 0,
      availableMemoryBytes: 0,
      availableDiskBytes: 0,
      requiredDiskBytes: 0,
      supported: false,
      recommended: false,
      warnings: [],
    },
  },
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_024 * 1_024 * 1_024) {
    return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
  }
  return `${(bytes / 1_024 / 1_024 / 1_024).toFixed(1)} GB`;
};

const formatDate = (seconds: number): string =>
  new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(seconds * 1_000));

const actionError = (
  result: KnowledgeActionResult,
  fallback: string,
): string => {
  if (result.accepted === false) {
    return (
      result.message ??
      (result.reason === 'conflict' ? '名称或来源已存在。' : fallback)
    );
  }
  return fallback;
};

export const KnowledgeCenter = ({
  workspaceId,
  navigatorOpen = true,
}: {
  workspaceId?: string;
  navigatorOpen?: boolean;
}) => {
  const [inspection, setInspection] = useState(EMPTY_INSPECTION);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [retrievalSettingsOpen, setRetrievalSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setError(undefined);
      setInspection(await getKnowledge());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取本地知识库。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized.length === 0
      ? inspection.knowledgeBases
      : inspection.knowledgeBases.filter((base) =>
          `${base.name}\n${base.description}`
            .toLocaleLowerCase()
            .includes(normalized),
        );
  }, [inspection.knowledgeBases, query]);
  const selected = inspection.knowledgeBases.find(
    (base) => base.id === selectedId,
  );
  const totalChunkCount = inspection.knowledgeBases.reduce(
    (sum, base) => sum + base.chunkCount,
    0,
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {retrievalSettingsOpen ? (
        <RetrievalSettingsPage
          inspection={inspection}
          leadingInset={!navigatorOpen}
          onBack={() => setRetrievalSettingsOpen(false)}
          onChanged={refresh}
        />
      ) : selected ? (
        <KnowledgeDetail
          base={selected}
          workspaceId={workspaceId}
          leadingInset={!navigatorOpen}
          onBack={() => setSelectedId(undefined)}
          onChanged={refresh}
        />
      ) : (
        <>
          <MainSurfaceHeader
            icon={<LibraryBig className="size-5" aria-hidden="true" />}
            title="本地知识库"
            description="把分散的本地资料整理成可检索上下文，在会话中明确 @ 后持续参与后续问答。"
            leadingInset={!navigatorOpen}
          >
            <div className="window-no-drag mt-5 flex flex-wrap items-start gap-2">
              <div className="min-w-56 max-w-3xl flex-1">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary"
                    aria-hidden="true"
                  />
                  <Input
                    className="pl-9"
                    placeholder="搜索知识库…"
                    aria-label="搜索知识库"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                {totalChunkCount > 0 ? (
                  <p className="mt-1.5 px-1 text-xs text-tertiary">
                    共 {totalChunkCount.toLocaleString()} 个索引片段
                  </p>
                ) : null}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRetrievalSettingsOpen(true)}
                >
                  <Settings2 aria-hidden="true" />检索设置
                </Button>
                <Button type="button" onClick={() => setCreateOpen(true)}>
                  <Plus aria-hidden="true" />创建知识库
                </Button>
              </div>
            </div>
          </MainSurfaceHeader>
          <main className="min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-8">
            {loading ? (
              <CenteredMessage
                icon={<LoaderCircle className="size-5 animate-spin" />}
                title="正在读取本地索引"
              />
            ) : error ? (
              <CenteredMessage
                icon={<AlertCircle className="size-5 text-destructive" />}
                title="知识库暂时不可用"
                description={error}
                action={
                  <Button variant="outline" onClick={() => void refresh()}>
                    重试
                  </Button>
                }
              />
            ) : inspection.knowledgeBases.length === 0 ? (
              <EmptyState onCreate={() => setCreateOpen(true)} />
            ) : visible.length === 0 ? (
              <CenteredMessage
                icon={<Search className="size-5" />}
                title="没有匹配的知识库"
                description="试试更短的名称或说明。"
              />
            ) : (
              <div className="mx-auto grid max-w-5xl gap-3 md:grid-cols-2 xl:grid-cols-3">
                {visible.map((base) => (
                  <KnowledgeCard
                    key={base.id}
                    base={base}
                    onOpen={() => setSelectedId(base.id)}
                  />
                ))}
              </div>
            )}
          </main>
        </>
      )}
      <CreateKnowledgeDialog
        open={createOpen}
        workspaceId={workspaceId}
        onOpenChange={setCreateOpen}
        onCreated={async (id) => {
          await refresh();
          setSelectedId(id);
        }}
      />
    </div>
  );
};

const KnowledgeCard = ({
  base,
  onOpen,
}: {
  base: KnowledgeBaseSummary;
  onOpen: () => void;
}) => (
  <button
    type="button"
    className="group rounded-xl border bg-background p-4 text-left transition-colors hover:border-foreground/20 hover:bg-surface/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onClick={onOpen}
  >
    <div className="flex items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-secondary group-hover:text-foreground">
        <BookOpenText className="size-4.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{base.name}</h2>
          {base.status === 'indexing' ? (
            <LoaderCircle className="size-3.5 animate-spin text-tertiary" />
          ) : null}
        </div>
        <p className="mt-1 line-clamp-2 min-h-10 text-xs leading-5 text-secondary">
          {base.description || '尚未添加说明。'}
        </p>
      </div>
    </div>
    <div className="mt-4 flex items-center justify-between border-t pt-3 text-[11px] text-tertiary">
      <span>{base.scope === 'global' ? '全局可见' : '指定项目'}</span>
      <span>
        {base.documentCount} 个文档 · {base.chunkCount} 个片段
      </span>
    </div>
  </button>
);

const EmptyState = ({ onCreate }: { onCreate: () => void }) => (
  <div className="mx-auto flex min-h-[22rem] max-w-3xl flex-col items-center justify-center rounded-2xl border border-dashed bg-surface/30 px-8 text-center">
    <span className="grid size-14 place-items-center rounded-2xl border bg-background shadow-sm">
      <FileStack className="size-6 text-secondary" aria-hidden="true" />
    </span>
    <h2 className="mt-5 text-base font-semibold">建立你的第一座本地资料库</h2>
    <p className="mt-2 max-w-lg text-sm leading-6 text-secondary">
      支持复制文件或链接文件夹。全文检索立即可用，不需要模型，也不会上传资料。
    </p>
    <Button type="button" className="mt-5" onClick={onCreate}>
      <FolderPlus aria-hidden="true" />创建知识库
    </Button>
    <p className="mt-5 flex items-center gap-1.5 text-xs text-tertiary">
      <ShieldCheck className="size-3.5" aria-hidden="true" />
      资料、索引与查询均保留在本机
    </p>
  </div>
);

const CenteredMessage = ({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) => (
  <div className="grid min-h-[20rem] place-items-center text-center">
    <div>
      <span className="mx-auto grid size-10 place-items-center rounded-xl border bg-surface">
        {icon}
      </span>
      <h2 className="mt-4 text-sm font-semibold">{title}</h2>
      {description ? (
        <p className="mt-2 max-w-lg text-xs leading-5 text-secondary">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  </div>
);

const CreateKnowledgeDialog = ({
  open,
  workspaceId,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  workspaceId?: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => Promise<void>;
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectScoped, setProjectScoped] = useState(false);
  const [source, setSource] = useState<SourceChoice>('files');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const created = await createKnowledgeBase({
        name: name.trim(),
        description: description.trim(),
        workspaceIds: projectScoped && workspaceId ? [workspaceId] : [],
      });
      if (!created.accepted || !created.knowledgeBaseId) {
        setError(actionError(created, '创建失败。'));
        return;
      }
      const id = created.knowledgeBaseId;
      const indexed =
        source === 'files'
          ? await addKnowledgeFiles(id)
          : source === 'folder'
            ? await addKnowledgeFolder(id)
            : undefined;
      if (
        indexed &&
        indexed.accepted === false &&
        indexed.reason !== 'cancelled'
      ) {
        setError(actionError(indexed, '知识库已创建，但资料添加失败。'));
      }
      setName('');
      setDescription('');
      setProjectScoped(false);
      setSource('files');
      onOpenChange(false);
      await onCreated(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建知识库失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-lg p-5">
        <DialogTitle className="text-base font-semibold">
          创建本地知识库
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm leading-6 text-secondary">
          默认建立本地全文索引，不下载或加载任何机器学习模型。
        </DialogDescription>
        <div className="mt-5 space-y-4">
          <label className="block text-xs font-medium">
            名称
            <Input
              className="mt-1.5"
              value={name}
              maxLength={80}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：产品规范"
            />
          </label>
          <label className="block text-xs font-medium">
            说明
            <div className="mt-1.5 rounded-lg border bg-background">
              <Textarea
                value={description}
                maxLength={1_024}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="这座知识库包含什么资料？"
              />
            </div>
          </label>
          <fieldset>
            <legend className="text-xs font-medium">可见范围</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <ChoiceButton
                active={!projectScoped}
                title="全局可见"
                description="项目任务和普通聊天均可 @"
                onClick={() => setProjectScoped(false)}
              />
              <ChoiceButton
                active={projectScoped}
                disabled={!workspaceId}
                title="当前项目"
                description={workspaceId ? '仅在当前项目中可 @' : '请先打开一个项目'}
                onClick={() => setProjectScoped(true)}
              />
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-xs font-medium">首个资料来源</legend>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              <ChoiceButton
                active={source === 'files'}
                title="复制文件"
                description="由 SugarCode 托管"
                onClick={() => setSource('files')}
              />
              <ChoiceButton
                active={source === 'folder'}
                title="链接目录"
                description="文件留在原位置"
                onClick={() => setSource('folder')}
              />
              <ChoiceButton
                active={source === 'none'}
                title="稍后添加"
                description="先创建空知识库"
                onClick={() => setSource('none')}
              />
            </div>
          </fieldset>
          {error ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? <LoaderCircle className="animate-spin" /> : <Plus />}
            创建并继续
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const ChoiceButton = ({
  active,
  disabled,
  title,
  description,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    disabled={disabled}
    className={`rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-45 ${
      active ? 'border-brand/25 bg-brand/10 text-brand' : 'hover:bg-surface'
    }`}
    onClick={onClick}
  >
    <span className="block text-xs font-medium">{title}</span>
    <span className="mt-0.5 block text-[10px] leading-4 text-tertiary">
      {description}
    </span>
  </button>
);

const KnowledgeDetail = ({
  base,
  workspaceId,
  leadingInset,
  onBack,
  onChanged,
}: {
  base: KnowledgeBaseSummary;
  workspaceId?: string;
  leadingInset: boolean;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) => {
  const [tab, setTab] = useState<DetailTab>('overview');
  const [detail, setDetail] = useState<KnowledgeBaseDetail>({
    sources: [],
    documents: [],
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [textEditor, setTextEditor] = useState<
    Readonly<{ mode: 'create' }> | Readonly<{ mode: 'edit'; sourceId: string }>
  >();

  const refreshDetail = useCallback(async (): Promise<void> => {
    try {
      setError(undefined);
      setDetail(await getKnowledgeBaseDetail(base.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取知识库详情。');
    } finally {
      setLoading(false);
    }
  }, [base.id]);

  useEffect(() => {
    void refreshDetail();
  }, [refreshDetail]);

  useEffect(() => {
    const interval = window.setInterval((): void => void refreshDetail(), 2_000);
    return () => window.clearInterval(interval);
  }, [refreshDetail]);

  const addSource = async (kind: 'files' | 'folder'): Promise<void> => {
    setBusy(true);
    try {
      const result =
        kind === 'files'
          ? await addKnowledgeFiles(base.id)
          : await addKnowledgeFolder(base.id);
      if (result.accepted === false && result.reason !== 'cancelled') {
        setError(actionError(result, '添加资料失败。'));
      }
      await Promise.all([refreshDetail(), onChanged()]);
    } finally {
      setBusy(false);
    }
  };

  const runSourceAction = async (
    action: () => Promise<KnowledgeActionResult>,
    fallback: string,
  ): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await action();
      if (!result.accepted) setError(actionError(result, fallback));
      await Promise.all([refreshDetail(), onChanged()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        className={`window-main-surface-header window-no-drag shrink-0 border-b bg-surface/30 px-6 py-4 sm:px-8 ${
          leadingInset ? 'window-collapsed-header' : ''
        }`}
      >
        <div className="flex flex-wrap items-start gap-3">
          <Button
            type="button"
            className="window-no-drag relative z-10"
            variant="ghost"
            size="icon"
            aria-label="返回知识库列表"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
          <div className="flex min-w-48 flex-1 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-surface">
              <BookOpenText className="size-4.5" />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold">{base.name}</h1>
              <p className="mt-0.5 truncate text-xs text-secondary">
                {base.description || '没有说明'}
              </p>
            </div>
          </div>
          <div className="window-no-drag flex items-center gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setTextEditor({ mode: 'create' })}
            >
              <FilePlus2 />新建文档
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void addSource('files')}
            >
              <FileText />添加文件
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void addSource('folder')}
            >
              <FolderPlus />链接目录
            </Button>
          </div>
        </div>
        <nav className="window-no-drag mt-4 flex gap-1 overflow-x-auto" aria-label="知识库详情">
          {(
            [
              ['overview', '概览'],
              ['content', '内容'],
              ['search', '检索测试'],
              ['settings', '设置'],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              size="sm"
              variant={tab === id ? 'secondary' : 'ghost'}
              onClick={() => setTab(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
        {loading ? (
          <CenteredMessage
            icon={<LoaderCircle className="size-5 animate-spin" />}
            title="读取知识库详情"
          />
        ) : null}
        {!loading && error ? (
          <p className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {!loading && tab === 'overview' ? (
          <Overview
            base={base}
            detail={detail}
            busy={busy}
            onDeleteSource={(id) =>
              runSourceAction(() => deleteKnowledgeSource(id), '删除资料来源失败。')
            }
            onRescanSource={(id, rebuild) =>
              runSourceAction(
                () => rescanKnowledgeSource(id, rebuild),
                rebuild ? '重建资料来源失败。' : '重新扫描失败。',
              )
            }
          />
        ) : null}
        {!loading && tab === 'content' ? (
          <ContentList
            detail={detail}
            onEdit={(sourceId) => setTextEditor({ mode: 'edit', sourceId })}
          />
        ) : null}
        {!loading && tab === 'search' ? <SearchTest base={base} /> : null}
        {!loading && tab === 'settings' ? (
          <SettingsPanel
            base={base}
            detail={detail}
            workspaceId={workspaceId}
            busy={busy}
            onSaved={async (request) => {
              await runSourceAction(
                () => updateKnowledgeBase(base.id, request),
                '保存知识库设置失败。',
              );
            }}
            onDelete={async () => {
              if (
                !window.confirm(
                  `删除知识库“${base.name}”？链接目录中的原文件不会被删除。`,
                )
              ) {
                return;
              }
              const result = await deleteKnowledgeBase(base.id);
              if (result.accepted) {
                await onChanged();
                onBack();
              } else {
                setError(actionError(result, '删除失败。'));
              }
            }}
          />
        ) : null}
      </main>
      <KnowledgeTextEditorDialog
        key={textEditor?.mode === 'edit' ? textEditor.sourceId : textEditor?.mode}
        open={textEditor !== undefined}
        knowledgeBaseId={base.id}
        sourceId={textEditor?.mode === 'edit' ? textEditor.sourceId : undefined}
        onOpenChange={(open) => {
          if (!open) setTextEditor(undefined);
        }}
        onSaved={async () => {
          await Promise.all([refreshDetail(), onChanged()]);
        }}
      />
    </div>
  );
};

const Overview = ({
  base,
  detail,
  busy,
  onDeleteSource,
  onRescanSource,
}: {
  base: KnowledgeBaseSummary;
  detail: KnowledgeBaseDetail;
  busy: boolean;
  onDeleteSource: (id: string) => Promise<void>;
  onRescanSource: (id: string, rebuild: boolean) => Promise<void>;
}) => (
  <div className="mx-auto max-w-4xl space-y-5">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Metric icon={<FileText />} label="文档" value={String(base.documentCount)} />
      <Metric
        icon={<Database />}
        label="索引片段"
        value={base.chunkCount.toLocaleString()}
      />
      <Metric
        icon={<HardDrive />}
        label="资料大小"
        value={formatBytes(base.sizeBytes)}
      />
      <Metric
        icon={<AlertCircle />}
        label="解析错误"
        value={String(base.errorCount)}
        warning={base.errorCount > 0}
      />
    </div>
    <section className="rounded-xl border">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">资料来源</h2>
      </div>
      {detail.sources.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-tertiary">
          尚未添加资料来源。
        </p>
      ) : (
        detail.sources.map((source) => (
          <div
            key={source.id}
            className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
          >
            {source.kind === 'linkedFolder' ? (
              <FolderPlus className="size-4 text-secondary" />
            ) : (
              <FileText className="size-4 text-secondary" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{source.displayName}</p>
              <p className="mt-0.5 truncate text-[10px] text-tertiary">
                {source.kind === 'linkedFolder'
                  ? '链接到本地目录'
                  : '已复制到 SugarCode'}{' '}
                · {source.path}
              </p>
              {source.lastError ? (
                <p className="mt-0.5 truncate text-[10px] text-destructive">
                  {source.lastError}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {source.status === 'scanning' ? (
                <LoaderCircle className="mr-1 size-3.5 animate-spin text-brand" />
              ) : source.status === 'disconnected' || source.status === 'error' ? (
                <AlertCircle className="mr-1 size-3.5 text-destructive" />
              ) : null}
              <span className="mr-2 text-[11px] text-tertiary">
                {source.documentCount} 个文档
              </span>
              {source.kind === 'linkedFolder' ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    title={source.status === 'disconnected' ? '恢复并扫描目录' : '重新扫描'}
                    onClick={() => void onRescanSource(source.id, false)}
                  >
                    <RefreshCw />
                    {source.status === 'disconnected' ? '恢复' : '扫描'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    title="重新解析此来源的全部文件"
                    onClick={() => void onRescanSource(source.id, true)}
                  >
                    重建
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  title="重新解析托管文件"
                  onClick={() => void onRescanSource(source.id, true)}
                >
                  重建
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                aria-label={`删除资料来源 ${source.displayName}`}
                onClick={() => {
                  if (
                    window.confirm(
                      source.kind === 'linkedFolder'
                        ? `移除“${source.displayName}”的索引？原目录不会被删除。`
                        : `删除托管文件“${source.displayName}”？`,
                    )
                  ) {
                    void onDeleteSource(source.id);
                  }
                }}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        ))
      )}
    </section>
    {(detail.indexJobs?.length ?? 0) > 0 ? (
      <section className="rounded-xl border">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">后台索引任务</h2>
        </div>
        {detail.indexJobs?.slice(0, 8).map((job) => {
          const active = job.status === 'queued' || job.status === 'running';
          const progress =
            job.discoveredFiles > 0
              ? Math.min(100, (job.processedFiles / job.discoveredFiles) * 100)
              : 0;
          return (
            <div key={job.id} className="border-b px-4 py-3 last:border-b-0">
              <div className="flex items-center gap-3 text-xs">
                {active ? (
                  <LoaderCircle className="size-3.5 animate-spin text-brand" />
                ) : job.status === 'failed' ? (
                  <AlertCircle className="size-3.5 text-destructive" />
                ) : (
                  <Database className="size-3.5 text-tertiary" />
                )}
                <span className="font-medium">
                  {job.kind === 'initial'
                    ? '首次索引'
                    : job.kind === 'incremental'
                      ? '增量更新'
                      : job.kind === 'rebuild'
                        ? '单来源重建'
                        : '重新扫描'}
                </span>
                <span className="text-tertiary">
                  {job.processedFiles}/{job.discoveredFiles} · 新增或更新 {job.indexedFiles} · 删除{' '}
                  {job.deletedFiles} · 错误 {job.errorCount}
                </span>
                <span className="ml-auto text-[10px] text-tertiary">{job.status}</span>
                {active ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void cancelKnowledgeIndexJob(job.id)}
                  >
                    取消
                  </Button>
                ) : (job.status === 'failed' || job.status === 'paused') && job.sourceId ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (job.sourceId) {
                        void onRescanSource(job.sourceId, job.kind === 'rebuild');
                      }
                    }}
                  >
                    重试
                  </Button>
                ) : null}
              </div>
              {active && job.discoveredFiles > 0 ? (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface">
                  <div className="h-full bg-brand" style={{ width: `${progress}%` }} />
                </div>
              ) : null}
              {job.lastError ? (
                <p className="mt-1 text-[10px] text-destructive">{job.lastError}</p>
              ) : null}
            </div>
          );
        })}
      </section>
    ) : null}
    <p className="text-xs text-tertiary">
      最后更新于 {formatDate(base.updatedAt)}。全文索引不加载机器学习模型。
    </p>
  </div>
);

const Metric = ({
  icon,
  label,
  value,
  warning,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  warning?: boolean;
}) => (
  <div className="rounded-xl border p-4">
    <span
      className={`[&_svg]:size-4 ${warning ? 'text-destructive' : 'text-tertiary'}`}
    >
      {icon}
    </span>
    <p className="mt-3 text-xl font-semibold tracking-tight">{value}</p>
    <p className="mt-0.5 text-[11px] text-tertiary">{label}</p>
  </div>
);

const ContentList = ({
  detail,
  onEdit,
}: {
  detail: KnowledgeBaseDetail;
  onEdit: (sourceId: string) => void;
}) => (
  <div className="mx-auto max-w-5xl overflow-hidden rounded-xl border">
    <div className="grid grid-cols-[minmax(0,1fr)_7rem_5rem_5rem_4rem] gap-3 border-b bg-surface/50 px-4 py-2 text-[10px] font-medium uppercase tracking-wide text-tertiary">
      <span>文件</span>
      <span>类型</span>
      <span>片段</span>
      <span>状态</span>
      <span className="text-right">操作</span>
    </div>
    {detail.documents.length === 0 ? (
      <p className="px-4 py-10 text-center text-xs text-tertiary">
        尚未索引任何文档。
      </p>
    ) : (
      detail.documents.map((document) => (
        <div
          key={document.id}
          className="grid grid-cols-[minmax(0,1fr)_7rem_5rem_5rem_4rem] items-center gap-3 border-b px-4 py-3 text-xs last:border-b-0"
        >
          <div className="min-w-0">
            <p className="truncate font-medium">{document.relativePath}</p>
            {document.parseError ? (
              <p className="mt-0.5 truncate text-[10px] text-destructive">
                {document.parseError}
              </p>
            ) : (
              <p className="mt-0.5 text-[10px] text-tertiary">
                {formatBytes(document.sizeBytes)}
              </p>
            )}
          </div>
          <span className="truncate text-tertiary">
            {document.mediaType.split('/').at(-1)}
          </span>
          <span>{document.chunkCount}</span>
          <span
            className={
              document.parseStatus === 'error' ? 'text-destructive' : 'text-secondary'
            }
          >
            {document.parseStatus === 'error' ? '有错误' : '已索引'}
          </span>
          <div className="flex justify-end">
            {detail.sources.some(
              (source) =>
                source.id === document.sourceId &&
                source.kind === 'managedFile',
            ) && /\.(?:txt|md)$/iu.test(document.fileName) ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`编辑 ${document.fileName}`}
                title="编辑托管文档"
                onClick={() => onEdit(document.sourceId)}
              >
                <Pencil />
              </Button>
            ) : (
              <span className="text-tertiary">—</span>
            )}
          </div>
        </div>
      ))
    )}
  </div>
);

const KnowledgeTextEditorDialog = ({
  open,
  knowledgeBaseId,
  sourceId,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  knowledgeBaseId: string;
  sourceId?: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) => {
  const [document, setDocument] = useState<KnowledgeEditableDocument>();
  const [fileName, setFileName] = useState('新建文档.md');
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    if (!sourceId) {
      setDocument(undefined);
      setFileName('新建文档.md');
      setContent('');
      setOriginalContent('');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void readKnowledgeTextDocument(sourceId)
      .then((next) => {
        if (cancelled) return;
        setDocument(next);
        setFileName(next.fileName);
        setContent(next.content);
        setOriginalContent(next.content);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : '无法读取托管文档。');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sourceId]);

  const bytes = new TextEncoder().encode(content).length;
  const dirty = sourceId
    ? content !== originalContent
    : content.length > 0 || fileName !== '新建文档.md';
  const validFileName =
    fileName.trim() === fileName &&
    fileName.length > 0 &&
    fileName.length <= 255 &&
    !fileName.includes('/') &&
    !fileName.includes('\\') &&
    ![...fileName].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) &&
    /\.(?:txt|md)$/iu.test(fileName);
  const canSave =
    !loading &&
    !saving &&
    validFileName &&
    content.trim().length > 0 &&
    bytes <= 2 * 1_024 * 1_024 &&
    (!sourceId || dirty) &&
    (!sourceId || document !== undefined);

  const requestClose = (): void => {
    if (saving) return;
    if (dirty && !window.confirm('放弃尚未保存的文档修改？')) return;
    onOpenChange(false);
  };

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = sourceId && document
        ? await updateKnowledgeTextDocument(sourceId, {
            expectedSha256: document.sha256,
            content,
          })
        : await createKnowledgeTextDocument(knowledgeBaseId, { fileName, content });
      if (!result.accepted) {
        setError(actionError(result, sourceId ? '保存文档失败。' : '创建文档失败。'));
        return;
      }
      setOriginalContent(content);
      await onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '文档保存失败。');
    } finally {
      setSaving(false);
    }
  };

  const setFormat = (format: 'md' | 'txt'): void => {
    setFileName((current) =>
      /\.(?:txt|md)$/iu.test(current)
        ? current.replace(/\.(?:txt|md)$/iu, `.${format}`)
        : `${current}.${format}`,
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DialogContent className="flex max-h-[88vh] max-w-4xl flex-col overflow-hidden p-0">
        <div className="border-b px-5 py-4">
          <DialogTitle className="text-base font-semibold">
            {sourceId ? '编辑知识文档' : '新建知识文档'}
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-5 text-secondary">
            保存后立即更新本地全文索引；语义索引会在后台继续处理。
          </DialogDescription>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {sourceId ? (
            <div className="mb-3 flex items-center gap-2 rounded-lg border bg-surface/40 px-3 py-2 text-xs">
              <FileText className="size-4 text-brand" />
              <span className="min-w-0 flex-1 truncate font-medium">{fileName}</span>
              <span className="text-tertiary">托管文档</span>
            </div>
          ) : (
            <div className="mb-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <label className="block text-xs font-medium">
                文件名
                <Input
                  className="mt-1.5"
                  value={fileName}
                  maxLength={255}
                  onChange={(event) => setFileName(event.target.value)}
                  placeholder="例如：公司信息.md"
                />
              </label>
              <fieldset>
                <legend className="text-xs font-medium">格式</legend>
                <div className="mt-1.5 flex rounded-lg border p-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={fileName.toLowerCase().endsWith('.md') ? 'secondary' : 'ghost'}
                    onClick={() => setFormat('md')}
                  >
                    Markdown
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={fileName.toLowerCase().endsWith('.txt') ? 'secondary' : 'ghost'}
                    onClick={() => setFormat('txt')}
                  >
                    纯文本
                  </Button>
                </div>
              </fieldset>
            </div>
          )}
          {loading ? (
            <div className="grid min-h-80 place-items-center text-xs text-tertiary">
              <span className="flex items-center gap-2">
                <LoaderCircle className="size-4 animate-spin" />读取文档内容
              </span>
            </div>
          ) : (
            <label className="block text-xs font-medium">
              内容
              <Textarea
                className="mt-1.5 min-h-[24rem] resize-y whitespace-pre-wrap font-mono text-[13px] leading-6"
                value={content}
                autoFocus={!sourceId}
                spellCheck={false}
                onChange={(event) => setContent(event.target.value)}
                placeholder={
                  fileName.toLowerCase().endsWith('.md')
                    ? '# 标题\n\n输入需要检索的知识内容…'
                    : '输入需要检索的知识内容…'
                }
              />
            </label>
          )}
          <div className="mt-2 flex items-center justify-between text-[10px] text-tertiary">
            <span>{content.split('\n').length} 行</span>
            <span className={bytes > 2 * 1_024 * 1_024 ? 'text-destructive' : ''}>
              {formatBytes(bytes)} / 2 MB
            </span>
          </div>
          {!validFileName && !sourceId ? (
            <p className="mt-2 text-xs text-destructive">
              文件名只能是当前目录中的 `.txt` 或 `.md` 文件。
            </p>
          ) : null}
          {error ? (
            <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <Button variant="ghost" disabled={saving} onClick={requestClose}>
            取消
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {saving ? <LoaderCircle className="animate-spin" /> : <Check />}
            {sourceId ? '保存并更新索引' : '创建并索引'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const SearchTest = ({ base }: { base: KnowledgeBaseSummary }) => {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<KnowledgeSearchResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (): Promise<void> => {
    if (!query.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await searchKnowledge([base.id], query.trim()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '检索失败。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="text-sm font-semibold">测试真实召回结果</h2>
      <p className="mt-1 text-xs leading-5 text-secondary">
        这里直接查询本机 FTS5/BM25 索引，结果与 Agent 获得的全文检索片段一致。
      </p>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入关键词或问题…"
        />
        <Button disabled={busy || !query.trim()}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Search />}
          检索
        </Button>
      </form>
      {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
      {result ? (
        <div className="mt-5 space-y-3">
          {result.hits.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-10 text-center text-xs text-tertiary">
              没有命中片段，请尝试更具体的关键词。
            </p>
          ) : (
            result.hits.map((hit) => (
              <article
                key={`${hit.documentId}-${hit.citation}`}
                className="rounded-xl border p-4"
              >
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="rounded bg-brand/10 px-1.5 py-0.5 font-semibold text-brand">
                    [{hit.citation}]
                  </span>
                  <span className="truncate font-medium">{hit.relativePath}</span>
                  {hit.heading ? (
                    <span className="truncate text-tertiary">/ {hit.heading}</span>
                  ) : null}
                  {hit.pageNumber ? (
                    <span className="shrink-0 text-tertiary">第 {hit.pageNumber} 页</span>
                  ) : hit.startLine ? (
                    <span className="shrink-0 text-tertiary">
                      行 {hit.startLine}
                      {hit.endLine && hit.endLine !== hit.startLine ? `–${hit.endLine}` : ''}
                    </span>
                  ) : null}
                </div>
                <p className="mt-3 whitespace-pre-wrap text-xs leading-5 text-secondary">
                  {hit.content}
                </p>
              </article>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
};

const modelStateLabel = (
  state: KnowledgeInspection['semanticModel']['state'],
): string => {
  if (state === 'ready') return '已安装';
  if (state === 'downloading') return '正在下载';
  if (state === 'error') return '需要修复';
  return '未安装';
};

const RetrievalSettingsPage = ({
  inspection,
  leadingInset,
  onBack,
  onChanged,
}: {
  inspection: KnowledgeInspection;
  leadingInset: boolean;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) => {
  const model = inspection.semanticModel;
  const plans = inspection.retrievalPlans ?? [];
  const selectedPlanId = inspection.retrievalSettings?.selectedPlanId ?? model.modelId;
  const [operation, setOperation] = useState<
    'install' | 'cancel' | 'remove' | 'select' | 'pause'
  >();
  const [actionMessage, setActionMessage] = useState<string>();
  const progress =
    model.totalBytes > 0
      ? Math.min(100, (model.downloadedBytes / model.totalBytes) * 100)
      : 0;

  useEffect(() => {
    const semanticWorkPending =
      model.state === 'ready' &&
      (model.semanticIndex.state === 'indexing' ||
        model.semanticIndex.state === 'paused' ||
        model.semanticIndex.indexedChunks < model.semanticIndex.totalChunks);
    if (
      model.state !== 'downloading' &&
      operation !== 'install' &&
      !semanticWorkPending
    ) {
      return undefined;
    }
    let refreshing = false;
    const interval = window.setInterval((): void => {
      if (refreshing) return;
      refreshing = true;
      void onChanged().finally(() => {
        refreshing = false;
      });
    }, 750);
    return () => window.clearInterval(interval);
  }, [model.semanticIndex, model.state, onChanged, operation]);

  const run = async (
    kind: 'install' | 'cancel' | 'remove' | 'select' | 'pause',
    action: () => Promise<KnowledgeActionResult>,
  ): Promise<void> => {
    setOperation(kind);
    setActionMessage(undefined);
    try {
      const result = await action();
      if (result.accepted === false && result.reason !== 'cancelled') {
        setActionMessage(actionError(result, '操作未完成，请稍后重试。'));
      }
    } catch (cause) {
      setActionMessage(cause instanceof Error ? cause.message : '操作未完成。');
    } finally {
      await onChanged();
      setOperation(undefined);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header
        className={`window-main-surface-header window-no-drag shrink-0 border-b bg-surface/30 px-6 py-4 sm:px-8 ${
          leadingInset ? 'window-collapsed-header' : ''
        }`}
      >
        <div className="flex items-start gap-3">
          <Button
            type="button"
            className="window-no-drag relative z-10"
            variant="ghost"
            size="icon"
            aria-label="返回知识库"
            onClick={onBack}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-background text-secondary shadow-sm">
            <Settings2 className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-base font-semibold">检索设置</h1>
            <p className="mt-1 text-sm leading-6 text-secondary">
              管理所有知识库共用的检索模型；各知识库的向量索引将在后台独立维护。
            </p>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
        <div className="mx-auto max-w-3xl space-y-5">
          <section className="rounded-xl border p-5">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
                <Search className="size-4" aria-hidden="true" />
              </span>
              <div>
                <h2 className="text-sm font-semibold">全局检索方案</h2>
                <p className="mt-1 text-xs leading-5 text-secondary">
                  全局一次只选择一个语义模型；知识库内部只决定是否使用当前共享模型。
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {plans.map((plan) => {
                const selected = plan.id === selectedPlanId;
                const pending = inspection.retrievalSettings?.pendingModelId === plan.id;
                return (
                  <div
                    key={plan.id}
                    className={`rounded-xl border p-4 transition-colors ${
                      selected ? 'border-brand/50 bg-brand/5' : 'bg-background'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">{plan.name}</p>
                        <p className="mt-1 text-[11px] leading-5 text-secondary">
                          {plan.description}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-surface px-2 py-1 text-[10px] text-tertiary">
                        {plan.downloadBytes === 0 ? '零下载' : formatBytes(plan.downloadBytes)}
                      </span>
                    </div>
                    {plan.model ? (
                      <p className="mt-3 text-[10px] text-tertiary">
                        {plan.model.dimensions} 维 · INT8 · 最低 SugarCode {plan.model.minimumAppVersion}
                      </p>
                    ) : null}
                    <Button
                      className="mt-3 w-full"
                      size="sm"
                      variant={selected ? 'outline' : 'default'}
                      disabled={operation !== undefined || selected}
                      onClick={() =>
                        void run('select', () => selectKnowledgeRetrievalPlan(plan.id))
                      }
                    >
                      {operation === 'select' && !selected ? (
                        <LoaderCircle className="animate-spin" aria-hidden="true" />
                      ) : selected ? (
                        <Check aria-hidden="true" />
                      ) : (
                        <Sparkles aria-hidden="true" />
                      )}
                      {pending ? '切换准备中' : selected ? '当前选择' : '选择此方案'}
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>

          {selectedPlanId !== 'fullText' ? (
          <section className="rounded-xl border p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
              <Sparkles className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">共享语义检索模型</h2>
                <span className="rounded-full border bg-surface px-2 py-1 text-[10px] font-medium text-secondary">
                  {modelStateLabel(model.state)}
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-secondary">
                模型全局安装一次，由所有知识库共用；不会改变默认聊天模型，也不会把资料上传到云端。
              </p>
            </div>
          </div>
          <dl className="mt-5 grid gap-3 rounded-lg bg-surface/60 p-4 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-tertiary">模型</dt>
              <dd className="mt-1 truncate font-medium">{model.modelId}</dd>
            </div>
            <div>
              <dt className="text-tertiary">运行格式</dt>
              <dd className="mt-1 font-medium">
                {model.runtime} · {model.variant}
              </dd>
            </div>
            <div>
              <dt className="text-tertiary">安装范围</dt>
              <dd className="mt-1 font-medium">SugarCode 全局共享</dd>
            </div>
          </dl>
          <div className="mt-4 rounded-lg border bg-background p-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-secondary">
                模型包 {formatBytes(model.totalBytes)} · 首次安装与索引建议预留{' '}
                {formatBytes(model.device.requiredDiskBytes)}
              </span>
              <span className="shrink-0 font-medium">
                可用 {formatBytes(model.device.availableDiskBytes)}
              </span>
            </div>
            {model.state === 'downloading' ? (
              <div className="mt-3">
                <div className="h-1.5 overflow-hidden rounded-full bg-surface">
                  <div
                    className="h-full rounded-full bg-brand transition-[width] duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] text-tertiary">
                  <span>
                    {formatBytes(model.downloadedBytes)} / {formatBytes(model.totalBytes)}
                  </span>
                  <span>{progress.toFixed(0)}%</span>
                </div>
              </div>
            ) : null}
          </div>
          {model.device.warnings.length > 0 ? (
            <div className="mt-3 space-y-1 rounded-lg bg-warning/10 px-3 py-2 text-[11px] leading-5 text-warning">
              {model.device.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          ) : null}
          {model.error || actionMessage ? (
            <p className="mt-3 text-xs leading-5 text-destructive">
              {actionMessage ?? model.error}
            </p>
          ) : null}
          {model.semanticIndex.state === 'error' && !model.error && !actionMessage ? (
            <p className="mt-3 text-xs leading-5 text-destructive">
              有 {model.semanticIndex.errorCount} 个知识库的语义索引未完成；全文检索仍然可用，可以重试索引。
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {model.state === 'ready' ? (
              <>
                {model.semanticIndex.totalChunks > 0 &&
                (model.semanticIndex.state === 'error' ||
                  model.semanticIndex.state === 'notIndexed') ? (
                  <Button
                    disabled={operation !== undefined}
                    onClick={() => void run('install', installSemanticModel)}
                  >
                    {operation === 'install' ? (
                      <LoaderCircle className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Sparkles aria-hidden="true" />
                    )}
                    重试语义索引
                  </Button>
                ) : null}
                {model.semanticIndex.totalChunks > 0 ? (
                  <Button
                    variant="outline"
                    disabled={operation !== undefined}
                    onClick={() =>
                      void run('pause', () =>
                        setSemanticIndexPaused(
                          !(inspection.retrievalSettings?.indexPaused ?? false),
                        ),
                      )
                    }
                  >
                    {inspection.retrievalSettings?.indexPaused ? (
                      <Play aria-hidden="true" />
                    ) : (
                      <Pause aria-hidden="true" />
                    )}
                    {inspection.retrievalSettings?.indexPaused ? '恢复语义索引' : '暂停语义索引'}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  disabled={operation !== undefined}
                  onClick={() => void run('remove', removeSemanticModel)}
                >
                  <Trash2 aria-hidden="true" />移除共享模型
                </Button>
              </>
            ) : model.state === 'downloading' ? (
              <Button
                variant="outline"
                disabled={operation === 'cancel'}
                onClick={() => void run('cancel', cancelSemanticModelDownload)}
              >
                {operation === 'cancel' ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <X aria-hidden="true" />
                )}
                取消下载
              </Button>
            ) : (
              <Button
                disabled={
                  operation === 'install' ||
                  !model.device.supported ||
                  model.device.availableDiskBytes < model.device.requiredDiskBytes
                }
                onClick={() => void run('install', installSemanticModel)}
              >
                {operation === 'install' ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Download aria-hidden="true" />
                )}
                {model.downloadedBytes > 0 ? '继续下载' : '下载并安装'}
              </Button>
            )}
          </div>
          </section>
          ) : null}

          <section className="rounded-xl border p-4">
          <h2 className="text-sm font-semibold">检索方式</h2>
          <div className="mt-3 divide-y rounded-lg bg-surface/60 px-3">
            <div className="flex items-center justify-between gap-4 py-3 text-xs">
              <div>
                <p className="font-medium">全文检索</p>
                <p className="mt-0.5 text-[10px] text-tertiary">
                  默认启用，无需模型
                </p>
              </div>
              <span className="rounded-full bg-success/10 px-2 py-1 text-[10px] font-medium text-success">
                始终可用
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 py-3 text-xs">
              <div>
                <p className="font-medium">语义检索</p>
                <p className="mt-0.5 text-[10px] text-tertiary">
                  共享模型只安装一次，向量索引按知识库独立建立
                </p>
              </div>
              <span className="rounded-full bg-surface px-2 py-1 text-[10px] text-tertiary">
                {model.semanticIndex.state === 'indexing'
                  ? `正在索引 ${model.semanticIndex.indexedChunks}/${model.semanticIndex.totalChunks}`
                  : model.semanticIndex.state === 'paused'
                    ? '索引已暂停，全文检索继续可用'
                  : model.semanticIndex.state === 'ready'
                    ? '混合检索可用'
                    : model.state === 'ready'
                      ? '等待建立索引'
                      : '未启用'}
              </span>
            </div>
          </div>
          </section>

          <p className="flex items-start gap-2 text-xs leading-5 text-tertiary">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            普通软件升级会复用兼容模型和索引；未安装模型时，所有知识库继续使用轻量全文检索。
          </p>
        </div>
      </main>
    </div>
  );
};

const SettingsPanel = ({
  base,
  detail,
  workspaceId,
  busy,
  onSaved,
  onDelete,
}: {
  base: KnowledgeBaseSummary;
  detail: KnowledgeBaseDetail;
  workspaceId?: string;
  busy: boolean;
  onSaved: (request: KnowledgeUpdateRequest) => Promise<void>;
  onDelete: () => Promise<void>;
}) => {
  const [name, setName] = useState(base.name);
  const [description, setDescription] = useState(base.description);
  const [projectScoped, setProjectScoped] = useState(base.scope === 'project');
  const [ignoreRules, setIgnoreRules] = useState((detail.ignoreRules ?? []).join('\n'));
  const [semanticEnabled, setSemanticEnabled] = useState(
    detail.semanticEnabled ?? base.semanticEnabled ?? false,
  );

  const save = (): void => {
    const workspaceIds = projectScoped
      ? base.workspaceIds.length > 0
        ? base.workspaceIds
        : workspaceId
          ? [workspaceId]
          : []
      : [];
    void onSaved({
      name: name.trim(),
      description: description.trim(),
      workspaceIds,
      ignoreRules: ignoreRules
        .split(/\r?\n/u)
        .map((rule) => rule.trim())
        .filter(Boolean),
      semanticEnabled,
    });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <section className="rounded-xl border p-5">
        <h2 className="text-sm font-semibold">基本信息与范围</h2>
        <div className="mt-4 grid gap-4">
          <label className="text-xs font-medium">
            名称
            <Input
              className="mt-1.5"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="text-xs font-medium">
            说明
            <div className="mt-1.5 rounded-lg border bg-background">
              <Textarea
                value={description}
                maxLength={1_024}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </label>
          <fieldset>
            <legend className="text-xs font-medium">可见范围</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <ChoiceButton
                active={!projectScoped}
                title="全局可见"
                description="所有项目和普通聊天均可 @"
                onClick={() => setProjectScoped(false)}
              />
              <ChoiceButton
                active={projectScoped}
                disabled={!workspaceId && base.workspaceIds.length === 0}
                title="项目范围"
                description={
                  base.workspaceIds.length > 0
                    ? `保留现有 ${base.workspaceIds.length} 个项目范围`
                    : workspaceId
                      ? '仅限当前项目'
                      : '请先打开一个项目'
                }
                onClick={() => setProjectScoped(true)}
              />
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-xs font-medium">当前知识库检索方式</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <ChoiceButton
                active={!semanticEnabled}
                title="仅全文检索"
                description="零模型依赖，内容变化后立即可检索"
                onClick={() => setSemanticEnabled(false)}
              />
              <ChoiceButton
                active={semanticEnabled}
                title="使用共享语义模型"
                description="只使用外层检索设置当前选择的模型"
                onClick={() => setSemanticEnabled(true)}
              />
            </div>
          </fieldset>
        </div>
      </section>
      <section className="rounded-xl border p-5">
        <h2 className="text-sm font-semibold">自定义忽略规则</h2>
        <p className="mt-2 text-xs leading-5 text-secondary">
          每行一条 glob 规则，例如 <code>drafts/**</code> 或 <code>*.secret.md</code>。
          规则在下次自动更新或手动扫描时生效；以 ! 开头可重新包含。
        </p>
        <div className="mt-3 rounded-lg border bg-background">
          <Textarea
            className="min-h-32 font-mono text-xs"
            value={ignoreRules}
            maxLength={32_768}
            placeholder={'drafts/**\n*.secret.md'}
            onChange={(event) => setIgnoreRules(event.target.value)}
          />
        </div>
        <p className="mt-2 text-[10px] leading-4 text-tertiary">
          始终忽略 .git、node_modules、构建目录、缓存、临时文件、.env* 与符号链接。
        </p>
        <Button className="mt-4" disabled={busy || !name.trim()} onClick={save}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Settings2 />}
          保存设置
        </Button>
      </section>
      <section className="rounded-xl border border-destructive/20 p-5">
        <h2 className="text-sm font-semibold">删除知识库</h2>
        <p className="mt-2 text-xs leading-5 text-secondary">
          删除索引和不再被其他知识库引用的 SugarCode 托管副本；链接目录中的原文件不会被删除。
        </p>
        <Button
          variant="destructive"
          className="mt-4"
          disabled={busy}
          onClick={() => void onDelete()}
        >
          <Trash2 />删除知识库
        </Button>
      </section>
    </div>
  );
};
