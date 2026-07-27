import {
  Clock3,
  FileLock2,
  ShieldAlert,
  WifiOff,
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
import { ScrollArea } from '@/renderer/components/ui/scroll-area';

import type {
  CommandApprovalRequestViewModel,
  CommandApprovalViewProps,
} from './types';
import { useStore } from './use-store';

const stringLiteral = (value: string): string => JSON.stringify(value);

const PolicyValue = ({
  label,
  value,
}: {
  label: string;
  value: string;
}) => (
  <div className="min-w-0 rounded-lg border bg-surface p-3">
    <dt className="text-xs font-medium text-tertiary">{label}</dt>
    <dd className="mt-1 break-all font-mono text-xs font-normal text-foreground">
      {value}
    </dd>
  </div>
);

const CommandDetails = ({
  request,
}: {
  request: CommandApprovalRequestViewModel;
}) => (
  <div className="space-y-5">
    <section aria-labelledby="approval-command-label">
      <h3
        id="approval-command-label"
        className="text-xs font-medium text-secondary"
      >
        Executable · argv[0]
      </h3>
      <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg border bg-surface p-3 font-mono text-xs font-normal text-foreground">
        <code>{stringLiteral(request.command)}</code>
      </pre>
    </section>

    <section aria-labelledby="approval-arguments-label">
      <div className="flex items-baseline justify-between gap-4">
        <h3
          id="approval-arguments-label"
          className="text-xs font-medium text-secondary"
        >
          Arguments
        </h3>
        <span className="text-xs text-tertiary">
          {request.arguments.length} items
        </span>
      </div>
      {request.arguments.length === 0 ? (
        <p className="mt-2 rounded-lg border bg-surface p-3 text-sm text-tertiary">
          No arguments
        </p>
      ) : (
        <ol
          className="mt-2 space-y-1.5"
          aria-label="Command arguments in argv order"
        >
          {request.arguments.map((argument, index) => (
            <li
              className="grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] gap-2 rounded-lg border bg-surface p-2.5"
              key={`${index}:${argument}`}
            >
              <span className="font-mono text-xs font-normal text-tertiary">
                argv[{index + 1}]
              </span>
              <code className="whitespace-pre-wrap break-all font-mono text-xs font-normal text-foreground">
                {stringLiteral(argument)}
              </code>
            </li>
          ))}
        </ol>
      )}
    </section>

    <section aria-labelledby="approval-context-label">
      <h3
        id="approval-context-label"
        className="text-xs font-medium text-secondary"
      >
        Execution context
      </h3>
      <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <PolicyValue label="Working directory" value={stringLiteral(request.cwd)} />
        <PolicyValue label="Approval scope" value={request.approvalScope} />
        <PolicyValue
          label="Environment policy"
          value={request.environmentPolicy}
        />
        <PolicyValue
          label="Filesystem sandbox"
          value={request.sandboxPolicy}
        />
        <PolicyValue label="Network policy" value={request.networkPolicy} />
        <PolicyValue
          label="Sandboxed"
          value={request.sandboxed ? 'true' : 'false'}
        />
      </dl>
    </section>

    <section
      className="rounded-lg border border-destructive/30 bg-destructive/10 p-3.5"
      aria-labelledby="approval-risk-label"
    >
      <div className="flex gap-3">
        <ShieldAlert
          className="mt-0.5 size-4 shrink-0 text-destructive"
          aria-hidden="true"
        />
        <div>
          <h3
            id="approval-risk-label"
            className="text-sm font-medium text-foreground"
          >
            Review before running
          </h3>
          <p className="mt-1 text-sm font-normal text-secondary">
            This command may read files SugarCode can access and include their
            contents in output. Filesystem writes and network access are denied.
            The process still has the existing 30 second execution limit.
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary">
            <span className="inline-flex items-center gap-1.5">
              <FileLock2 className="size-3.5" aria-hidden="true" />
              Read-only filesystem
            </span>
            <span className="inline-flex items-center gap-1.5">
              <WifiOff className="size-3.5" aria-hidden="true" />
              Network denied
            </span>
          </div>
        </div>
      </div>
    </section>
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
                    <AlertDialogTitle>
                      Allow this command once?
                    </AlertDialogTitle>
                    <AlertDialogDescription className="mt-1">
                      Review the exact argv and enforced policies. Approval
                      applies only to this command request.
                    </AlertDialogDescription>
                  </div>
                  <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-surface px-2.5 py-1 font-mono text-xs font-normal text-secondary">
                    <Clock3 className="size-3.5" aria-hidden="true" />
                    {store.secondsRemaining}s
                  </div>
                </div>
              </AlertDialogHeader>
            </div>

            <ScrollArea
              className="min-h-0 max-h-[calc(100vh-15rem)]"
              viewportProps={{
                tabIndex: 0,
                'aria-label': 'Command approval details',
              }}
            >
              <div className="px-5 py-5 sm:px-6">
                <CommandDetails request={request} />
              </div>
            </ScrollArea>

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
                  Deny
                </Button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!store.canAct}
                  onClick={() => void store.approve()}
                >
                  {isSubmitting ? 'Recording decision…' : 'Approve once & run'}
                </Button>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      {store.snapshot.status !== 'idle' &&
      store.snapshot.status !== 'pending' ? (
        <div
          className="fixed right-4 bottom-4 z-40 max-w-sm rounded-lg border bg-background px-3.5 py-2.5 text-sm text-secondary shadow-lg"
          role="status"
          aria-live="polite"
        >
          {store.statusMessage}
        </div>
      ) : null}
    </>
  );
};

export const CommandApprovalSurface = () => (
  <CommandApprovalView store={useStore()} />
);
