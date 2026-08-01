import {
  Check,
  Clock3,
  FolderCheck,
  MessagesSquare,
  ShieldQuestion,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import type { CommandApprovalMode } from '@/shared/command-approval';

import type {
  CommandApprovalModeControlProps,
  CommandApprovalViewProps,
} from './types';
import { useStore } from './use-store';

const MODE_COPY: Record<
  CommandApprovalMode,
  Readonly<{
    label: string;
    description: string;
    icon: typeof ShieldQuestion;
  }>
> = {
  ask: {
    label: '请求批准',
    description: '每条需要授权的命令都会先询问你。',
    icon: ShieldQuestion,
  },
  thread: {
    label: '本次任务自动批准',
    description: '仅当前任务后续的沙箱命令不再重复询问。',
    icon: MessagesSquare,
  },
  workspace: {
    label: '当前工作区自动批准',
    description: '此工作区后续的沙箱命令自动执行，直到你切回请求批准。',
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
      <AlertDialog open={store.isOpen}>
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
                    <AlertDialogTitle>SugarCode 如何执行命令？</AlertDialogTitle>
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
              <p className="rounded-lg border bg-surface px-3 py-2.5 font-mono text-xs font-normal leading-normal text-foreground">
                {request.description}
              </p>
              <div className="mt-4">
                <PermissionModeOptions
                  selectedMode={store.selectedMode}
                  onSelect={store.setSelectedMode}
                />
              </div>
              <p className="mt-3 text-xs leading-5 text-tertiary">
                自动批准只减少重复确认；命令仍受 SugarCode 的只读文件与禁网沙箱约束。
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
  disabled,
}: CommandApprovalModeControlProps) => {
  const effectiveMode =
    store.snapshot.mode === 'thread' &&
    store.snapshot.modeThreadId &&
    store.snapshot.modeThreadId !== threadId
      ? 'ask'
      : store.snapshot.mode;
  return (
    <Select
      value={effectiveMode}
      disabled={disabled || store.modePending || store.isOpen}
      onValueChange={(value) =>
        void store.changeMode(value as CommandApprovalMode, threadId ?? undefined)
      }
    >
      <SelectTrigger
        className="h-7 w-auto max-w-56 border-0 bg-transparent px-1.5 text-xs shadow-none"
        aria-label="后续命令授权模式"
      >
        <ShieldQuestion className="size-3.5" aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MODES.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {MODE_COPY[mode].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export const CommandApprovalSurface = () => (
  <CommandApprovalView store={useStore()} />
);
