import { Clock3, Fingerprint, PlugZap, ShieldAlert } from 'lucide-react';
import { useRef } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog';
import { Button } from '@/renderer/components/ui/button';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { focusWorkspaceTask } from '@/renderer/services/workspace';
import { isApprovalVisibleForThread } from '@/renderer/utils/approval-visibility';

import type { McpApprovalSurfaceProps } from './types';

const AGENT_ROLE_LABELS = {
  explorer: '探索',
  worker: '执行',
  auditor: '审查',
} as const;

const prettyJson = (value: string): string => {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

const displayToolName = (serverId: string, name: string): string => {
  const prefix = `mcp__${serverId}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
};

const McpApprovalSurfaceContent = ({
  store,
  activeThreadId,
}: McpApprovalSurfaceProps) => {
  const denyRef = useRef<HTMLButtonElement>(null);
  const request = store.approvalRequests.find(
    (item) => item.threadId === activeThreadId,
  );
  const canApprove = request ? store.canApprove(request) : false;
  const secondsRemaining = request ? store.secondsRemaining(request) : 0;
  const submitting =
    request?.actionState === 'submittingApproval' ||
    request?.actionState === 'submittingDenial';
  const argumentsJson = request ? prettyJson(request.argumentsJson) : '';
  const toolName = request
    ? displayToolName(request.serverId, request.name)
    : '';

  return (
    <AlertDialog
      open={isApprovalVisibleForThread(
        request?.threadId,
        activeThreadId,
      )}
    >
      {request ? (
        <AlertDialogContent
          className="grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] max-w-[46rem]"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            if (canApprove) {
              void store.deny(request);
            }
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            denyRef.current?.focus();
          }}
        >
          <div className="min-w-0 border-b px-5 py-4 sm:px-6">
            <AlertDialogHeader>
              <div className="flex min-w-0 items-start justify-between gap-4">
                <div className="min-w-0">
                  <AlertDialogTitle className="flex min-w-0 items-center gap-2">
                    <PlugZap className="size-5 shrink-0 text-tertiary" aria-hidden="true" />
                    允许这次 MCP 调用？
                  </AlertDialogTitle>
                  <AlertDialogDescription className="mt-1">
                    所选本地服务只会获得本次调用授权，此决定不会被记住。
                    {request.sourceAgent
                      ? ` 请求来自${AGENT_ROLE_LABELS[request.sourceAgent.role]}智能体 ${request.sourceAgent.taskId}。`
                      : ''}
                  </AlertDialogDescription>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-surface px-2.5 py-1 font-mono text-xs text-secondary">
                  <Clock3 className="size-3.5" aria-hidden="true" />
                  {secondsRemaining} 秒
                </span>
              </div>
            </AlertDialogHeader>
          </div>

          <ScrollArea
            className="min-h-0 min-w-0 w-full max-w-full"
            viewportProps={{
              tabIndex: 0,
              'aria-label': 'MCP 调用授权详情',
              className: 'min-w-0 [&>div]:!block [&>div]:min-w-0 [&>div]:max-w-full',
            }}
          >
            <div className="min-w-0 max-w-full space-y-5 overflow-hidden px-5 py-5 sm:px-6">
              <section className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-surface px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-foreground">
                    {request.projectTitle} / {request.conversationTitle}
                  </p>
                  <p className="mt-0.5 text-[11px] text-tertiary">
                    {request.queueCount > 1
                      ? `全局授权队列中共有 ${request.queueCount} 项`
                      : '全局授权队列中的当前项目'}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void focusWorkspaceTask(request.threadId)}
                >
                  查看任务
                </Button>
              </section>
              <section aria-labelledby="mcp-call-name">
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-tertiary">
                  {request.serverId}
                </p>
                <h3
                  id="mcp-call-name"
                  className="mt-1 break-all font-mono text-sm font-medium"
                  title={request.name}
                >
                  {toolName}
                </h3>
              </section>

              <section aria-labelledby="mcp-arguments-title">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 id="mcp-arguments-title" className="text-xs font-medium text-secondary">
                    标准化 JSON 参数
                  </h3>
                  <span className="font-mono text-[10px] text-tertiary">
                    {request.argumentsBytes} 字节
                  </span>
                </div>
                <pre className="mt-2 max-w-full overflow-hidden whitespace-pre-wrap break-all rounded-lg border bg-surface p-3 font-mono text-xs font-normal leading-5 text-foreground">
                  <code>{argumentsJson}</code>
                </pre>
              </section>

              <section className="grid gap-2 sm:grid-cols-2" aria-label="MCP 调用凭据">
                <div className="min-w-0 rounded-lg border bg-surface p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-secondary">
                    <Fingerprint className="size-3.5" aria-hidden="true" />
                    参数 SHA-256
                  </p>
                  <p className="mt-1 break-all font-mono text-[10px] leading-4 text-tertiary">
                    {request.argumentsSha256}
                  </p>
                </div>
                <div className="min-w-0 rounded-lg border bg-surface p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-secondary">
                    <Fingerprint className="size-3.5" aria-hidden="true" />
                    工具清单 SHA-256
                  </p>
                  <p className="mt-1 break-all font-mono text-[10px] leading-4 text-tertiary">
                    {request.inventorySha256}
                  </p>
                </div>
              </section>

              <section className="rounded-lg border border-destructive/30 bg-destructive/10 p-3.5">
                <div className="flex gap-3">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                  <div>
                    <h3 className="text-sm font-medium">服务端定义的操作</h3>
                    <p className="mt-1 text-sm font-normal leading-normal text-secondary">
                      SugarCode 会校验固定的工具清单并记录执行凭据，但具体操作及其外部影响由所选服务负责。
                    </p>
                  </div>
                </div>
              </section>
            </div>
          </ScrollArea>

          <AlertDialogFooter className="min-w-0 border-t bg-surface px-5 py-4 sm:items-center sm:px-6">
            <p className="mr-auto min-h-5 min-w-0 flex-1 text-xs text-secondary" aria-live="polite">
              {store.actionError ? (
                <span className="text-destructive" role="alert">
                  {store.actionError}
                </span>
              ) : request.actionState === 'localWindowElapsed' ? (
                '授权等待时间已结束，正在按默认策略允许本次调用…'
              ) : submitting ? (
                '正在记录本次决定…'
              ) : (
                `${secondsRemaining} 秒后将按默认策略允许；按 Esc 可拒绝。`
              )}
            </p>
            <AlertDialogCancel asChild>
              <Button
                ref={denyRef}
                type="button"
                variant="outline"
                disabled={!canApprove}
                onClick={() => void store.deny(request)}
              >
                拒绝
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                disabled={!canApprove}
                onClick={() => void store.approve(request)}
              >
                仅允许本次
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
};

export const McpApprovalSurface = (props: McpApprovalSurfaceProps) =>
  typeof window.sugarcode?.getMcpApprovalState === 'function' ? (
    <McpApprovalSurfaceContent {...props} />
  ) : null;
