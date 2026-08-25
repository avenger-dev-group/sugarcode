import { Clock3, PlugZap } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { isApprovalVisibleForThread } from '@/renderer/utils/approval-visibility';

import type { McpApprovalSurfaceProps } from './types';

const displayToolName = (serverId: string, name: string): string => {
  const prefix = `mcp__${serverId}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
};

const McpApprovalView = ({
  store,
  activeThreadId,
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
      aria-busy={submitting}
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
          {store.actionError ? (
            <span className="text-destructive" role="alert">
              {store.actionError}
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
        <Button
          type="button"
          size="sm"
          disabled={!canApprove}
          onClick={() => void store.approve(request)}
        >
          {submitting ? '处理中…' : '允许本次'}
        </Button>
      </footer>
    </section>
  );
};

export const McpApprovalSurface = (props: McpApprovalSurfaceProps) =>
  typeof window.sugarcode?.getMcpApprovalState === 'function' ? (
    <McpApprovalView {...props} />
  ) : null;
