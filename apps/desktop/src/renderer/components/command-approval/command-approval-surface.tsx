import {
  Check,
  Clock3,
  FolderCheck,
  FilePenLine,
  Hand,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
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
import { focusWorkspaceTask } from '@/renderer/services/workspace';
import { isApprovalVisibleForThread } from '@/renderer/utils/approval-visibility';
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
    description: '写入项目文件或访问网络前，先征求你的同意',
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

const PermissionModeOptions = ({
  selectedMode,
  onSelect,
}: Readonly<{
  selectedMode: CommandApprovalMode;
  onSelect: (mode: CommandApprovalMode) => void;
}>) => (
  <div className="space-y-1.5" role="radiogroup" aria-label="后续授权模式">
    {MODES.map((mode) => {
      const copy = MODE_COPY[mode];
      const Icon = copy.icon;
      const selected = selectedMode === mode;
      return (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={selected}
          onClick={() => onSelect(mode)}
          className={`flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            selected
              ? 'border-border bg-surface-hover text-foreground'
              : 'border-transparent text-secondary hover:bg-surface'
          }`}
        >
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border bg-background">
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{copy.label}</span>
            <span className="mt-0.5 block text-xs leading-5 text-tertiary">
              {copy.description}
            </span>
          </span>
          {selected ? (
            <Check className="mt-1 size-4 shrink-0" aria-hidden="true" />
          ) : null}
        </button>
      );
    })}
  </div>
);

export const CommandApprovalView = ({
  store,
  activeThreadId,
}: CommandApprovalViewProps) => {
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const { request } = store;
  const actionState = request?.actionState;
  const isSubmitting =
    actionState === 'submittingApproval' ||
    actionState === 'submittingDenial';
  const pendingMessage =
    actionState === 'localWindowElapsed'
      ? 'The local approval window elapsed. Waiting for SugarCode to confirm expiry.'
      : actionState === 'submittingApproval'
        ? 'Submitting one-time approval. Waiting for the recorded decision.'
        : actionState === 'submittingDenial'
          ? 'Submitting denial. Waiting for the recorded decision.'
          : `${store.secondsRemaining} seconds remain locally. The server may expire this request sooner.`;

  return (
    <>
      <AlertDialog
        open={isApprovalVisibleForThread(
          request?.threadId,
          activeThreadId,
        )}
      >
        {request ? (
          <AlertDialogContent
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              if (store.canAct) {
                void store.deny();
              }
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              denyButtonRef.current?.focus();
            }}
          >
            <div className="border-b px-5 py-4 sm:px-6">
              <AlertDialogHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <AlertDialogTitle>
                      {request.operationKind === 'workspacePatch'
                        ? '允许修改项目文件？'
                        : 'SugarCode 如何执行命令？'}
                    </AlertDialogTitle>
                    <AlertDialogDescription className="mt-1">
                      {request.sourceAgent
                        ? `由 ${request.sourceAgent.role} Agent ${request.sourceAgent.taskId} 请求。`
                        : '为当前命令授权，并选择后续授权模式。'}
                    </AlertDialogDescription>
                  </div>
                  <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-surface px-2.5 py-1 font-mono text-xs font-normal text-secondary">
                    <Clock3 className="size-3.5" aria-hidden="true" />
                    {store.secondsRemaining}s
                  </div>
                </div>
              </AlertDialogHeader>
            </div>

            <div className="px-5 py-6 sm:px-6">
              <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border bg-surface px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-foreground">
                    {request.projectTitle} / {request.conversationTitle}
                  </p>
                  <p className="mt-0.5 text-[11px] text-tertiary">
                    {request.queueCount > 1
                      ? `全局审批队列中共 ${request.queueCount} 项`
                      : '全局审批队列中的当前项目'}
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
              </div>
              <div className="rounded-lg border bg-surface px-3 py-2.5">
                <p className="text-xs leading-5 text-secondary">
                  {request.description}
                </p>
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-tertiary">
                  {request.operationKind === 'workspacePatch' ? (
                    <FilePenLine className="size-3.5" aria-hidden="true" />
                  ) : (
                    <SquareTerminal className="size-3.5" aria-hidden="true" />
                  )}
                  {request.operationKind === 'workspacePatch'
                    ? '项目文件修改'
                    : request.fullAccess
                      ? 'Full Access Shell'
                      : '只读禁网沙箱'} · cwd {request.cwd}
                  {request.platformShell ? ` · ${request.platformShell}` : ''}
                </div>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-background px-2.5 py-2 font-mono text-xs leading-5 text-foreground">
                  {request.command}
                </pre>
              </div>
              <div className="mt-4">
                <PermissionModeOptions
                  selectedMode={store.selectedMode}
                  onSelect={store.setSelectedMode}
                />
              </div>
              <p className="mt-3 text-xs leading-5 text-tertiary">
                {request.fullAccess
                  ? 'Full Access 可访问网络及工作区外文件。完全访问授权仅保存在当前应用会话中，可随时切回请求批准。'
                  : '完全访问模式会自动批准后续受控操作；切回请求批准即可恢复逐次确认。'}
              </p>
            </div>

            <AlertDialogFooter className="border-t bg-surface px-5 py-4 sm:items-center sm:px-6">
              <div
                className="mr-auto min-h-5 text-xs text-secondary"
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
              <AlertDialogCancel asChild>
                <Button
                  ref={denyButtonRef}
                  type="button"
                  variant="outline"
                  disabled={!store.canAct}
                  onClick={() => void store.deny()}
                >
                  拒绝
                </Button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!store.canAct}
                  onClick={() => void store.approve()}
                >
                  {isSubmitting ? '正在记录授权…' : '允许并继续'}
                </Button>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </>
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
      disabled={disabled || store.modePending || store.isOpen}
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
