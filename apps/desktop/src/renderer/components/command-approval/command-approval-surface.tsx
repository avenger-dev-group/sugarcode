import { Clock3 } from 'lucide-react';
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

import type { CommandApprovalViewProps } from './types';
import { useStore } from './use-store';

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
                    <AlertDialogTitle>Approval required</AlertDialogTitle>
                    <AlertDialogDescription className="mt-1">
                      {request.sourceAgent
                        ? `Requested by ${request.sourceAgent.role} Agent ${request.sourceAgent.taskId}.`
                        : 'SugarCode needs your permission to continue.'}
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
              <p className="text-sm font-normal leading-normal text-foreground">
                {request.description}
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
                  {isSubmitting ? 'Recording decision…' : 'Allow once'}
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
