import {
  BookOpen,
  CircleHelp,
  Library,
  ListTree,
  LoaderCircle,
  Search,
  Square,
  X,
} from 'lucide-react';

import type {
  KnowledgeActivityViewModel,
  ProcessLanguage,
} from './types';

const tone = (state: KnowledgeActivityViewModel['state']): string => {
  if (state === 'running' || state === 'stopping') return 'text-process';
  if (state === 'failed') return 'text-destructive';
  return state === 'succeeded' ? 'text-secondary' : 'text-tertiary';
};

const ActivityIcon = ({ activity }: Readonly<{ activity: KnowledgeActivityViewModel }>) => {
  if (activity.state === 'running' || activity.state === 'stopping') {
    return <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  }
  if (activity.state === 'failed') return <X className="size-3.5" aria-hidden="true" />;
  if (activity.state === 'uncertain') return <CircleHelp className="size-3.5" aria-hidden="true" />;
  if (activity.state === 'interrupted') return <Square className="size-3.5" aria-hidden="true" />;
  if (activity.operation === 'search') return <Search className="size-3.5" aria-hidden="true" />;
  if (activity.operation === 'listDocuments') return <ListTree className="size-3.5" aria-hidden="true" />;
  return <BookOpen className="size-3.5" aria-hidden="true" />;
};

const operationLabel = (
  activity: KnowledgeActivityViewModel,
  language: ProcessLanguage,
): string => {
  const active = activity.state === 'running' || activity.state === 'stopping';
  const failed = activity.state === 'failed';
  if (language === 'zh') {
    if (activity.operation === 'search') return failed ? '知识检索失败' : active ? '正在检索知识库' : '已检索知识库';
    if (activity.operation === 'listDocuments') return failed ? '文档列表读取失败' : active ? '正在读取文档列表' : '已读取文档列表';
    return failed ? '知识来源读取失败' : active ? '正在读取知识来源' : '已读取知识来源';
  }
  if (activity.operation === 'search') return failed ? 'Knowledge search failed' : active ? 'Searching knowledge' : 'Searched knowledge';
  if (activity.operation === 'listDocuments') return failed ? 'Document listing failed' : active ? 'Listing documents' : 'Listed documents';
  return failed ? 'Source read failed' : active ? 'Reading source' : 'Read source';
};

const modeLabel = (
  mode: KnowledgeActivityViewModel['mode'],
  language: ProcessLanguage,
): string | undefined => {
  if (!mode) return undefined;
  if (language === 'zh') {
    return mode === 'hybrid'
      ? '混合检索'
      : mode === 'fullText'
        ? '全文检索'
        : mode === 'documentList'
          ? '文档列表'
          : '分段读取';
  }
  return mode === 'hybrid'
    ? 'Hybrid'
    : mode === 'fullText'
      ? 'Full text'
      : mode === 'documentList'
        ? 'Document list'
        : 'Chunk read';
};

export const KnowledgeActivity = ({
  activity,
  language,
}: Readonly<{
  activity: KnowledgeActivityViewModel;
  language: ProcessLanguage;
}>) => {
  const mode = modeLabel(activity.mode, language);
  const names = activity.knowledgeBases.map((base) => base.name).join('、');
  const countLabel = activity.matches === undefined
    ? undefined
    : language === 'zh'
      ? `${activity.matches.toLocaleString('zh-CN')} 个结果`
      : `${activity.matches.toLocaleString('en-US')} results`;
  return (
    <div
      className="flex min-w-0 items-start gap-2.5 py-1 text-sm leading-5"
      role={activity.state === 'failed' ? 'alert' : 'status'}
      aria-label={operationLabel(activity, language)}
    >
      <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center ${tone(activity.state)}`}>
        <ActivityIcon activity={activity} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={tone(activity.state)}>{operationLabel(activity, language)}</span>
          {names ? (
            <span className="inline-flex min-w-0 items-center gap-1 text-secondary">
              <Library className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{names}</span>
            </span>
          ) : null}
          {mode ? <span className="font-mono text-[10px] text-tertiary">{mode}</span> : null}
          {countLabel ? <span className="ml-auto font-mono text-[10px] text-tertiary">{countLabel}</span> : null}
        </div>
        {activity.query ? (
          <p className="mt-0.5 break-words font-mono text-[11px] text-tertiary">
            “{activity.query}”
          </p>
        ) : null}
        {activity.errorKind ? (
          <p className="mt-0.5 text-xs text-destructive">{activity.errorKind}</p>
        ) : null}
      </div>
    </div>
  );
};
