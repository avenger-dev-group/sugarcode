import { Clock3, PlugZap } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '@/renderer/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/renderer/components/ui/select';
import { isApprovalVisibleForThread } from '@/renderer/utils/approval-visibility';
import type { CommandApprovalMode } from '@/shared/command-approval';

import type { McpApprovalSurfaceProps } from './types';

const displayToolName = (serverId: string, name: string): string => {
  const prefix = `mcp__${serverId}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
};

const APPROVAL_MODES: readonly CommandApprovalMode[] = [
  'ask',
  'thread',
  'workspace',
];

const APPROVAL_MODE_COPY: Record<
  CommandApprovalMode,
  Readonly<{ label: string; description: string }>
> = {
  ask: {
    label: '允许本次',
    description: '仅允许当前这一次 MCP 调用',
  },
  thread: {
    label: '本次会话完全访问',
    description: '此对话后续的 MCP 与完整访问操作将自动允许',
  },
  workspace: {
    label: '当前项目完全访问',
    description: '此项目内后续的 MCP 与完整访问操作将自动允许',
  },
};

const McpApprovalView = ({
  store,
  permissionStore,
  activeThreadId,
  activeWorkspaceId,
}: McpApprovalSurfaceProps) => {
  const denyRef = useRef<HTMLButtonElement>(null);
  const request = store.approvalRequests.find((item) =>
    isApprovalVisibleForThread(item.threadId, activeThreadId),
  );
  const canApprove = request ? store.canApprove(request) : false;
  const secondsRemaining = request ? store.secondsRemaining(request) : 0;
  const submitting =
    request?.actionState === 'submittingApproval' ||
    request?.actionState === 'submittingDenial';
  const actionPending = submitting || permissionStore.modePending;

  useEffect(() => {
    if (request && canApprove) {
      denyRef.current?.focus();
    }
  }, [canApprove, request?.presentationId]);

  if (!request) {
    return null;
  }

  const toolName = displayToolName(request.serverId, request.name);
  const pendingMessage =
    request.actionState === 'localWindowElapsed'
      ? '授权等待已结束，正在按默认规则允许并继续。'
      : request.actionState === 'submittingApproval'
        ? '正在允许本次调用…'
        : request.actionState === 'submittingDenial'
          ? '正在拒绝本次调用…'
          : `${secondsRemaining} 秒后将默认允许并继续。`;

  return (
    <section
      className="flex max-h-[min(20rem,42vh)] min-h-40 flex-col overflow-hidden rounded-2xl border bg-background shadow-[0_18px_60px_var(--shadow-soft)] animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
      aria-labelledby={`${request.presentationId}:title`}
      aria-describedby={`${request.presentationId}:description`}
      aria-busy={actionPending}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && canApprove) {
          event.preventDefault();
          void store.deny(request);
        }
      }}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-xs text-secondary">
          <PlugZap className="size-3.5 shrink-0" aria-hidden="true" />
          <span id={`${request.presentationId}:title`} className="truncate">
            {request.serverId} · {toolName}
          </span>
          {request.queueCount > 1 ? (
            <span className="rounded-full bg-surface px-1.5 py-0.5 text-[10px] tabular-nums text-tertiary">
              {request.queueCount} 项待处理
            </span>
          ) : null}
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-tertiary">
          <Clock3 className="size-3" aria-hidden="true" />
          {secondsRemaining}s
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        <p
          id={`${request.presentationId}:description`}
          className="break-words text-sm font-medium leading-6 text-primary"
        >
          {request.purpose}
        </p>
        <p className="mt-2 text-xs leading-5 text-tertiary">
          将通过 {request.serverId} 调用此工具，仅授权本次操作。
        </p>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border-subtle px-3 py-2">
        <div
          className="mr-auto min-w-0 flex-1 truncate text-xs text-tertiary"
          aria-live="polite"
          aria-atomic="true"
        >
          {store.actionError || permissionStore.actionError ? (
            <span className="text-destructive" role="alert">
              {store.actionError ?? permissionStore.actionError}
            </span>
          ) : (
            pendingMessage
          )}
        </div>
        <Button
          ref={denyRef}
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canApprove}
          onClick={() => void store.deny(request)}
          title="按 Escape 拒绝"
        >
          拒绝
          <kbd className="ml-1 rounded bg-surface px-1 py-0.5 font-sans text-[10px] font-normal text-tertiary">
            Esc
          </kbd>
        </Button>
        <div className="flex items-center rounded-lg bg-brand text-brand-foreground">
          <Button
            type="button"
            size="sm"
            className="rounded-r-none border-r border-brand-foreground/20 px-3 hover:bg-brand-hover"
            disabled={!canApprove || permissionStore.modePending}
            onClick={() => void store.approve(request)}
          >
            {actionPending ? '处理中…' : '允许本次'}
          </Button>
          <Select
            value="ask"
            disabled={!canApprove || permissionStore.modePending}
            onValueChange={(value) => {
              const mode = value as CommandApprovalMode;
              if (mode === 'ask') {
                void store.approve(request);
                return;
              }
              void permissionStore.changeMode(
                mode,
                request.threadId,
                activeWorkspaceId ?? undefined,
              );
            }}
          >
            <SelectTrigger
              className="h-7 w-8 justify-center gap-0 rounded-l-none border-0 border-l border-brand-foreground/20 bg-brand p-0 text-brand-foreground shadow-none hover:bg-brand-hover focus-visible:ring-brand-foreground/40 [&>svg]:m-0 [&>svg]:size-3.5 [&>svg]:text-brand-foreground"
              aria-label="选择 MCP 授权范围"
              title="选择授权范围"
            />
            <SelectContent side="top" align="end" className="w-56">
              {APPROVAL_MODES.map((mode) => (
                <SelectItem
                  key={mode}
                  value={mode}
                  disabled={mode === 'workspace' && !activeWorkspaceId}
                >
                  <span className="flex flex-col">
                    <span className="text-sm text-foreground">
                      {APPROVAL_MODE_COPY[mode].label}
                    </span>
                    <span className="text-[11px] leading-4 text-tertiary">
                      {APPROVAL_MODE_COPY[mode].description}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </footer>
    </section>
  );
};

export const McpApprovalSurface = (props: McpApprovalSurfaceProps) =>
  typeof window.sugarcode?.getMcpApprovalState === 'function' ? (
    <McpApprovalView {...props} />
  ) : null;
