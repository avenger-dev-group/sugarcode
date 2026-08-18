import {
  Clock3,
  FolderCheck,
  FilePenLine,
  Hand,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '@/renderer/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/renderer/components/ui/select';
import {
  resolveCommandApprovalMode,
  type CommandApprovalMode,
} from '@/shared/command-approval';

import type {
  CommandApprovalModeControlProps,
  CommandApprovalViewProps,
} from './types';
import { commandApprovalDisplayCommand } from './presentation';

const MODE_COPY: Record<
  CommandApprovalMode,
  Readonly<{
    label: string;
    description: string;
    icon: LucideIcon;
  }>
> = {
  ask: {
    label: '请求批准',
    description: '访问网络、项目外文件或运行非沙箱命令前请求批准',
    icon: Hand,
  },
  thread: {
    label: '本次会话完全访问',
    description: '仅此对话可自动访问网络及本机文件',
    icon: ShieldCheck,
  },
  workspace: {
    label: '当前项目完全访问',
    description: '该项目下的操作将自动执行，直到你切回请求批准',
    icon: FolderCheck,
  },
};

const MODES: readonly CommandApprovalMode[] = [
  'ask',
  'thread',
  'workspace',
];

const APPROVAL_MODE_LABEL: Record<CommandApprovalMode, string> = {
  ask: '允许一次',
  thread: '本次会话',
  workspace: '当前项目',
};

export const CommandApprovalView = ({
  store,
  activeThreadId,
}: CommandApprovalViewProps) => {
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const request = store.requests.find(
    (item) => item.threadId === activeThreadId,
  );
  const actionState = request?.actionState;
  const canAct = request ? store.canAct(request) : false;
  const secondsRemaining = request ? store.secondsRemaining(request) : 0;
  const isSubmitting =
    actionState === 'submittingApproval' ||
    actionState === 'submittingDenial';
  const pendingMessage =
    actionState === 'localWindowElapsed'
      ? '授权等待已结束，正在按默认规则允许并继续。'
      : actionState === 'submittingApproval'
        ? '正在记录本次授权…'
        : actionState === 'submittingDenial'
          ? '正在记录拒绝决定…'
          : `${secondsRemaining} 秒后将默认允许并继续。`;

  useEffect(() => {
    if (request && canAct) {
      denyButtonRef.current?.focus();
    }
  }, [canAct, request?.presentationId]);

  if (!request) {
    return null;
  }

  return (
    <section
      className="flex max-h-[min(24rem,48vh)] min-h-40 flex-col overflow-hidden rounded-2xl border bg-background shadow-[0_18px_60px_var(--shadow-soft)] animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
      aria-labelledby={`${request.presentationId}:title`}
      aria-describedby={`${request.presentationId}:description`}
      aria-busy={isSubmitting}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && canAct) {
          event.preventDefault();
          void store.deny(request);
        }
      }}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-xs text-secondary">
          {request.operationKind === 'workspacePatch' ? (
            <FilePenLine className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <SquareTerminal className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span id={`${request.presentationId}:title`} className="truncate">
            {request.operationKind === 'projectEnvironment'
              ? '项目环境信任'
              : request.operationKind === 'workspacePatch'
                ? '文件修改'
                : '终端'}
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

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        <p
          id={`${request.presentationId}:description`}
          className="text-sm font-medium leading-relaxed text-primary"
        >
          {request.description}
        </p>
        <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface px-3 py-2.5 font-mono text-xs leading-5 text-secondary">
          {commandApprovalDisplayCommand(request)}
        </pre>
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
          ref={denyButtonRef}
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canAct}
          onClick={() => void store.deny(request)}
          title="按 Escape 拒绝"
        >
          拒绝
          <kbd className="ml-1 rounded bg-surface px-1 py-0.5 font-sans text-[10px] font-normal text-tertiary">
            Esc
          </kbd>
        </Button>
        {request.operationKind === 'projectEnvironment' ? (
          <Button
            type="button"
            size="sm"
            disabled={!canAct}
            onClick={() => void store.approve(request, 'ask')}
          >
            {isSubmitting ? '正在信任…' : '信任此配置'}
          </Button>
        ) : (
        <div className="flex items-center rounded-lg bg-brand text-brand-foreground">
          <Button
            type="button"
            size="sm"
            className="rounded-r-none border-r border-brand-foreground/20 px-3 hover:bg-brand-hover"
            disabled={!canAct}
            onClick={() => void store.approve(request)}
          >
            {isSubmitting
              ? '正在授权…'
              : APPROVAL_MODE_LABEL[store.selectedMode(request)]}
          </Button>
          <Select
            value={store.selectedMode(request)}
            disabled={!canAct}
            onValueChange={(value) => {
              const mode = value as CommandApprovalMode;
              store.setSelectedMode(request.presentationId, mode);
              void store.approve(request, mode);
            }}
          >
            <SelectTrigger
              className="h-7 w-8 justify-center gap-0 rounded-l-none border-0 border-l border-brand-foreground/20 bg-brand p-0 text-brand-foreground shadow-none hover:bg-brand-hover focus-visible:ring-brand-foreground/40 [&>svg]:m-0 [&>svg]:size-3.5 [&>svg]:text-brand-foreground"
              aria-label="选择授权范围"
              title="选择授权范围"
            />
            <SelectContent side="top" align="end" className="w-52">
              {MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  <span className="flex flex-col">
                    <span className="text-sm text-foreground">
                      {APPROVAL_MODE_LABEL[mode]}
                    </span>
                    <span className="text-[11px] leading-4 text-tertiary">
                      {MODE_COPY[mode].description}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        )}
      </footer>
    </section>
  );
};

export const CommandApprovalModeControl = ({
  store,
  threadId,
  workspaceId,
  disabled,
}: CommandApprovalModeControlProps) => {
  const effectiveMode = resolveCommandApprovalMode(
    store.snapshot,
    threadId,
    workspaceId,
  );
  const ActiveIcon = MODE_COPY[effectiveMode].icon;
  return (
    <Select
      value={effectiveMode}
      disabled={disabled || store.modePending}
      onValueChange={(value) =>
        void store.changeMode(
          value as CommandApprovalMode,
          threadId ?? undefined,
          workspaceId ?? undefined,
        )
      }
    >
      <SelectTrigger
        className="group h-7 w-auto max-w-56 border-0 bg-transparent px-1.5 text-xs shadow-none data-[state=open]:bg-surface [&>svg:last-child]:size-3.5 [&>svg:last-child]:transition-transform data-[state=open]:[&>svg:last-child]:rotate-180"
        aria-label="当前会话权限"
      >
        <ActiveIcon className="size-3.5" aria-hidden="true" />
        <span className="truncate">{MODE_COPY[effectiveMode].label}</span>
      </SelectTrigger>
      <SelectContent
        side="top"
        align="start"
        sideOffset={8}
        className="max-h-none w-[22.5rem] max-w-[calc(100vw-2rem)] rounded-2xl border bg-background shadow-[0_16px_48px_var(--shadow-soft)]"
      >
        <div className="flex items-start justify-between gap-4 px-3.5 pt-3.5 pb-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              SugarCode 如何执行操作？
            </p>
            <p className="mt-0.5 text-xs font-normal text-tertiary">
              为当前对话设置访问边界
            </p>
          </div>
          <span className="shrink-0 rounded-full border bg-surface px-2 py-0.5 text-[11px] font-normal text-tertiary">
            权限
          </span>
        </div>
        {MODES.map((mode) => (
          <SelectItem
            key={mode}
            value={mode}
            textValue={MODE_COPY[mode].label}
            disabled={
              (mode === 'thread' && !threadId) ||
              (mode === 'workspace' && !workspaceId)
            }
            className="my-0.5 min-h-14 p-0 pr-9 text-foreground data-[state=checked]:bg-surface [&>span:first-child]:w-full [&>span:last-child]:top-4 [&>span:last-child]:right-3"
          >
            <span className="flex w-full items-start gap-3 px-2.5 py-2.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-full border bg-background shadow-sm">
                {(() => {
                  const Icon = MODE_COPY[mode].icon;
                  return <Icon className="size-3.5" aria-hidden="true" />;
                })()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium leading-5">
                  {MODE_COPY[mode].label}
                </span>
                <span className="block text-xs font-normal leading-5 text-tertiary">
                  {MODE_COPY[mode].description}
                </span>
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
