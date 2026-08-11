import {
  BookOpen,
  ChevronDown,
  CircleHelp,
  FolderOpen,
  ListChecks,
  LoaderCircle,
  Plug,
  Search,
  Square,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useMemo } from 'react';

import { CommandExecutionResult } from '@/renderer/components/agent/command-execution-result';
import { useOrchestrationStore } from '@/renderer/components/orchestration/use-store';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/renderer/components/ui/tooltip';
import { FileChangeReview } from '@/renderer/components/workspace/file-change-review';
import { toWorkspacePatchReviewFile } from '@/renderer/components/workspace/unified-diff';
import { createShortestUniquePathLabels } from '@/renderer/utils/file-display-name';

import type { CompactToolActivity, ProcessLanguage } from './types';
import {
  commandActivityAction,
  commandActivityFailed,
} from './tool-activity';
import { toolActivityGroupSummary } from './tool-activity-copy';
import { useActivityDisclosureStore } from './use-store';

type WorkspaceActivity = Extract<
  CompactToolActivity,
  { type: 'workspaceRead' | 'workspaceList' | 'workspaceSearch' }
>;

type CommandActivity = Extract<
  CompactToolActivity,
  { type: 'commandApproval' }
>;

type McpActivity = Extract<CompactToolActivity, { type: 'mcp' }>;

const formatBytes = (bytes: number): string => {
  if (bytes < 1_000) {
    return `${bytes} B`;
  }
  if (bytes < 1_000_000) {
    return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  }
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
};

const stateTone = (state: WorkspaceActivity['activity']['state']): string => {
  switch (state) {
    case 'running':
    case 'stopping':
      return 'text-process';
    case 'failed':
      return 'text-destructive';
    case 'uncertain':
      return 'text-tertiary';
    case 'interrupted':
      return 'text-secondary';
    case 'succeeded':
      return 'text-secondary';
  }
};

const StateIcon = ({
  state,
  type,
}: Readonly<{
  state: WorkspaceActivity['activity']['state'];
  type: WorkspaceActivity['type'];
}>) => {
  if (state === 'running' || state === 'stopping') {
    return (
      <LoaderCircle
        className="size-3.5 animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }
  if (state === 'failed') {
    return <X className="size-3.5" aria-hidden="true" />;
  }
  if (state === 'uncertain') {
    return <CircleHelp className="size-3.5" aria-hidden="true" />;
  }
  if (state === 'interrupted') {
    return <Square className="size-3.5" aria-hidden="true" />;
  }
  if (type === 'workspaceRead') {
    return <BookOpen className="size-3.5" aria-hidden="true" />;
  }
  if (type === 'workspaceList') {
    return <FolderOpen className="size-3.5" aria-hidden="true" />;
  }
  return <Search className="size-3.5" aria-hidden="true" />;
};

const actionCopy = (
  entry: WorkspaceActivity,
  language: ProcessLanguage,
): string => {
  const { state } = entry.activity;
  const active = state === 'running' || state === 'stopping';
  const failed = state === 'failed';
  if (language === 'zh') {
    switch (entry.type) {
      case 'workspaceRead':
        return failed ? '读取失败' : active ? '正在读取' : '已读取';
      case 'workspaceList':
        return failed ? '列出失败' : active ? '正在列出' : '已列出';
      case 'workspaceSearch':
        return failed ? '搜索失败' : active ? '正在搜索' : '已搜索';
    }
  }
  switch (entry.type) {
    case 'workspaceRead':
      return failed ? 'Failed to read' : active ? 'Reading' : 'Read';
    case 'workspaceList':
      return failed ? 'Failed to list' : active ? 'Listing' : 'Listed';
    case 'workspaceSearch':
      return failed ? 'Search failed' : active ? 'Searching' : 'Searched';
  }
};

const ariaLabel = (
  entry: WorkspaceActivity,
  language: ProcessLanguage,
): string => {
  if (language === 'zh') {
    const target = entry.type === 'workspaceSearch'
      ? `${entry.activity.query}，路径 ${entry.activity.path}`
      : entry.activity.path;
    return `${actionCopy(entry, language)}：${target}`;
  }
  const { state } = entry.activity;
  const stateLabel =
    state === 'succeeded'
      ? 'complete'
      : state === 'running'
        ? 'in progress'
        : state;
  switch (entry.type) {
    case 'workspaceRead':
      return `Workspace read ${stateLabel}: ${entry.activity.path}`;
    case 'workspaceList':
      return `Workspace list ${stateLabel}: ${entry.activity.path}`;
    case 'workspaceSearch':
      return `Workspace search ${stateLabel}: ${entry.activity.query}`;
  }
};

const metadata = (
  entry: WorkspaceActivity,
  language: ProcessLanguage,
): string | null => {
  switch (entry.type) {
    case 'workspaceRead':
      return entry.activity.bytes === undefined
        ? null
        : formatBytes(entry.activity.bytes);
    case 'workspaceList':
      return entry.activity.entries === undefined
        ? null
        : language === 'zh'
          ? `${entry.activity.entries.toLocaleString('zh-CN')} 项`
          : `${entry.activity.entries.toLocaleString('en-US')} ${
            entry.activity.entries === 1 ? 'entry' : 'entries'
          }`;
    case 'workspaceSearch':
      return entry.activity.matches === undefined
        ? null
        : language === 'zh'
          ? `${entry.activity.matches.toLocaleString('zh-CN')}${
              entry.activity.truncated ? '+' : ''
            } 个匹配`
          : `${entry.activity.matches.toLocaleString('en-US')}${
              entry.activity.truncated ? '+' : ''
            } matches`;
  }
};

const WorkspaceRow = ({
  entry,
  language,
  pathLabel,
}: Readonly<{
  entry: WorkspaceActivity;
  language: ProcessLanguage;
  pathLabel?: string;
}>) => {
  const { openFile } = useOrchestrationStore();
  const detail =
    entry.type === 'workspaceSearch'
      ? language === 'zh'
        ? `“${entry.activity.query}”，位于 ${entry.activity.path}`
        : `“${entry.activity.query}” in ${entry.activity.path}`
      : entry.activity.path;
  const meta = metadata(entry, language);
  return (
    <div
      className="flex min-w-0 items-start gap-2.5 py-1"
      role={entry.activity.state === 'failed' ? 'alert' : 'status'}
      aria-label={ariaLabel(entry, language)}
      data-state={entry.activity.state}
    >
      <span
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center ${stateTone(
          entry.activity.state,
        )}`}
      >
        <StateIcon state={entry.activity.state} type={entry.type} />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm leading-5">
        <span className={stateTone(entry.activity.state)}>
          {actionCopy(entry, language)}
        </span>
        {entry.type === 'workspaceRead' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="min-w-0 break-all text-left font-mono text-[12px] text-secondary underline decoration-border underline-offset-2 hover:text-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => openFile(entry.activity.path)}
              >
                {pathLabel ?? detail}
              </button>
            </TooltipTrigger>
            <TooltipContent className="break-all font-mono" side="top">
              {entry.activity.path}
            </TooltipContent>
          </Tooltip>
        ) : (
          <code className="min-w-0 break-all font-mono text-[12px] text-secondary">
            {detail}
          </code>
        )}
        {meta ? (
          <span className="ml-auto whitespace-nowrap font-mono text-[10px] text-tertiary">
            {meta}
          </span>
        ) : null}
        {entry.activity.errorKind ? (
          <span className="w-full break-all pl-0 font-mono text-[10px] text-destructive">
            {entry.activity.errorKind}
          </span>
        ) : null}
      </div>
    </div>
  );
};

const CommandRow = ({
  entry,
  language,
}: Readonly<{
  entry: CommandActivity;
  language: ProcessLanguage;
}>) => {
  const failed = commandActivityFailed(entry);
  const result = entry.activity.executionResult;
  const active =
    entry.activity.state === 'approved' &&
    entry.activity.executionAttempt !== undefined &&
    result === undefined;
  const action = commandActivityAction(entry, failed, active, language);
  const metadata =
    result?.outcome.type === 'process'
      ? `${result.outcome.durationMs.toLocaleString('en-US')} ms`
      : result?.outcome.type === 'workspacePatch'
        ? language === 'zh'
          ? `${result.outcome.filesChanged} 个文件`
          : `${result.outcome.filesChanged} file${result.outcome.filesChanged === 1 ? '' : 's'}`
      : null;
  const tone = failed
    ? 'text-destructive'
    : active
      ? 'text-process'
      : 'text-secondary';
  const stdout = entry.activity.liveOutput?.stdout ?? '';
  const stderr = entry.activity.liveOutput?.stderr ?? '';
  const workspacePatch = entry.activity.operationKind === 'workspacePatch';
  if (
    workspacePatch &&
    result?.outcome.type === 'workspacePatch' &&
    result.outcome.files &&
    result.outcome.files.length > 0
  ) {
    return (
      <div className="space-y-0.5" role="status" aria-label={action}>
        {result.outcome.files.map((file, index) => {
          const change = toWorkspacePatchReviewFile(
            `${entry.activity.id}:${index}:${file.path}`,
            file,
          );
          return (
            <FileChangeReview
              key={`${file.path}:${index}`}
              review={{
                id: `${entry.activity.id}:${index}`,
                path: file.path,
                state: 'applied',
                ...(change ? { change, files: [change] } : {}),
              }}
              variant="compact"
              language={language}
            />
          );
        })}
      </div>
    );
  }
  return (
    <details
      className="group/command min-w-0"
      role={failed ? 'alert' : 'status'}
      aria-label={`${action}: ${entry.activity.command}`}
      data-state={entry.activity.state}
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-start gap-2.5 rounded-md py-1 pr-1 outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <span
          className={`mt-0.5 flex size-4 shrink-0 items-center justify-center ${tone}`}
        >
          {active ? (
            <LoaderCircle
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : failed ? (
            <X className="size-3.5" aria-hidden="true" />
          ) : (
            <SquareTerminal className="size-3.5" aria-hidden="true" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm leading-5">
          <span className={tone}>{action}</span>
          {entry.activity.approvalSource === 'policy' ? (
            <span className="rounded-full border px-1.5 font-mono text-[9px] text-tertiary">
              {language === 'zh' ? '继承项目授权' : 'Inherited access'}
            </span>
          ) : null}
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-secondary underline decoration-border underline-offset-2">
            {entry.activity.command}
          </code>
          {metadata ? (
            <span className="whitespace-nowrap font-mono text-[10px] text-tertiary">
              {metadata}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className="mt-0.5 size-3.5 shrink-0 text-tertiary transition-transform motion-reduce:transition-none group-open/command:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="mb-1.5 ml-6 mt-1 min-w-0 overflow-hidden rounded-lg border bg-surface">
        <div className="border-b px-3 py-1.5 text-xs font-medium text-secondary">
          {workspacePatch ? 'Patch' : 'Shell'}
        </div>
        <div
          className="max-h-72 overflow-auto px-3 py-2.5 font-mono text-xs font-normal leading-5"
          tabIndex={0}
          role="region"
          aria-label={`${workspacePatch ? 'Patch' : 'Shell'} execution detail`}
        >
          <pre className="whitespace-pre-wrap break-words text-secondary">
            <span className="select-none text-tertiary">$ </span>
            {entry.activity.command}
          </pre>
          {stdout ? (
            <pre className="mt-2 whitespace-pre-wrap break-words text-secondary">
              {stdout}
            </pre>
          ) : null}
          {stderr ? (
            <pre className="mt-2 whitespace-pre-wrap break-words text-destructive">
              {stderr}
            </pre>
          ) : null}
          {!stdout && !stderr && !result ? (
            <p className="mt-2 text-tertiary">
              {language === 'zh' ? '暂无执行输出' : 'No execution output'}
            </p>
          ) : null}
          {result ? <CommandExecutionResult result={result} /> : null}
        </div>
      </div>
    </details>
  );
};

const McpRow = ({
  entry,
  language,
}: Readonly<{
  entry: McpActivity;
  language: ProcessLanguage;
}>) => {
  const failed =
    entry.activity.state === 'toolError' ||
    entry.activity.state === 'failed' ||
    entry.activity.state === 'uncertain';
  const active =
    entry.activity.state === 'approved' || entry.activity.state === 'attempted';
  const action = language === 'zh'
    ? failed
      ? '工具调用失败'
      : active
        ? '正在调用'
        : entry.activity.state === 'succeeded'
          ? '已调用'
          : entry.activity.state === 'denied'
            ? '已拒绝'
            : '工具调用已停止'
    : failed
      ? 'Tool call failed'
      : active
        ? 'Calling'
        : entry.activity.state === 'succeeded'
          ? 'Called'
          : entry.activity.state === 'denied'
            ? 'Denied'
            : 'Tool call stopped';
  const metadata =
    entry.activity.receipt?.type === 'completed'
      ? formatBytes(entry.activity.receipt.retainedBytes)
      : null;
  const tone = failed
    ? 'text-destructive'
    : active
      ? 'text-process'
      : 'text-secondary';
  return (
    <div
      className="flex min-w-0 items-start gap-2.5 py-1"
      role={failed ? 'alert' : 'status'}
      aria-label={`${action}: ${entry.activity.name}`}
      data-state={entry.activity.state}
    >
      <span
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center ${tone}`}
      >
        {active ? (
          <LoaderCircle
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : failed ? (
          <X className="size-3.5" aria-hidden="true" />
        ) : (
          <Plug className="size-3.5" aria-hidden="true" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm leading-5">
        <span className={tone}>{action}</span>
        <code className="min-w-0 break-all font-mono text-[12px] text-secondary underline decoration-border underline-offset-2">
          {entry.activity.name}
        </code>
        {metadata ? (
          <span className="ml-auto whitespace-nowrap font-mono text-[10px] text-tertiary">
            {metadata}
          </span>
        ) : null}
      </div>
    </div>
  );
};

export const ToolActivityGroup = ({
  activities,
  language,
}: Readonly<{
  activities: readonly CompactToolActivity[];
  language: ProcessLanguage;
}>) => {
  const store = useActivityDisclosureStore(activities[0]?.activity.id ?? '');
  const readPathLabels = useMemo(
    () => createShortestUniquePathLabels(
      activities.flatMap((entry) =>
        entry.type === 'workspaceRead' ? [entry.activity.path] : [],
      ),
    ),
    [activities],
  );

  return (
    <details
      open={store.expanded}
      onToggle={(event) => store.setExpanded(event.currentTarget.open)}
      className="group/process min-w-0"
      aria-label={
        language === 'zh'
          ? `${activities.length} 个工具活动`
          : `${activities.length} tool activities`
      }
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md py-1 pr-1 text-sm text-secondary outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ListChecks
          className="size-3.5 shrink-0 text-tertiary"
          aria-hidden="true"
        />
        <span className="min-w-0">
          {toolActivityGroupSummary(activities, language)}
        </span>
        <ChevronDown
          className="size-3.5 shrink-0 text-tertiary transition-transform motion-reduce:transition-none group-open/process:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <ol className="relative ml-1.5 mt-0.5 max-h-80 overflow-y-auto overscroll-y-auto border-l border-border/70 pl-3 pr-1">
        {activities.map((entry) => (
          <li key={`${entry.type}:${entry.activity.id}`} className="min-w-0">
            {entry.type === 'fileChange' ? (
              <FileChangeReview
                review={entry.activity}
                variant="compact"
                language={language}
              />
            ) : entry.type === 'commandApproval' ? (
              <CommandRow entry={entry} language={language} />
            ) : entry.type === 'mcp' ? (
              <McpRow entry={entry} language={language} />
            ) : (
              <WorkspaceRow
                entry={entry}
                language={language}
                pathLabel={
                  entry.type === 'workspaceRead'
                    ? readPathLabels.get(entry.activity.path)
                    : undefined
                }
              />
            )}
          </li>
        ))}
      </ol>
    </details>
  );
};
