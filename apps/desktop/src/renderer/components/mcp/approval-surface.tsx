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

import { useStore } from './use-store';

const McpApprovalSurfaceContent = () => {
  const store = useStore();
  const denyRef = useRef<HTMLButtonElement>(null);
  const request = store.approvalRequest;
  const submitting =
    request?.actionState === 'submittingApproval' ||
    request?.actionState === 'submittingDenial';

  return (
    <AlertDialog open={request !== null}>
      {request ? (
        <AlertDialogContent
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            if (store.canApprove) {
              void store.deny();
            }
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            denyRef.current?.focus();
          }}
        >
          <div className="border-b px-5 py-4 sm:px-6">
            <AlertDialogHeader>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <AlertDialogTitle className="flex items-center gap-2">
                    <PlugZap className="size-5 text-tertiary" aria-hidden="true" />
                    Allow this MCP call once?
                  </AlertDialogTitle>
                  <AlertDialogDescription className="mt-1">
                    The selected local server will receive exactly one approved
                    call. This decision is not remembered.
                  </AlertDialogDescription>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-surface px-2.5 py-1 font-mono text-xs text-secondary">
                  <Clock3 className="size-3.5" aria-hidden="true" />
                  {store.secondsRemaining}s
                </span>
              </div>
            </AlertDialogHeader>
          </div>

          <ScrollArea
            className="min-h-0 max-h-[calc(100vh-15rem)]"
            viewportProps={{
              tabIndex: 0,
              'aria-label': 'MCP approval details',
            }}
          >
            <div className="space-y-5 px-5 py-5 sm:px-6">
              <section aria-labelledby="mcp-call-name">
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-tertiary">
                  {request.serverId}
                </p>
                <h3
                  id="mcp-call-name"
                  className="mt-1 break-all font-mono text-sm font-medium"
                >
                  {request.name}
                </h3>
              </section>

              <section aria-labelledby="mcp-arguments-title">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 id="mcp-arguments-title" className="text-xs font-medium text-secondary">
                    Canonical JSON arguments
                  </h3>
                  <span className="font-mono text-[10px] text-tertiary">
                    {request.argumentsBytes} bytes
                  </span>
                </div>
                <pre className="mt-2 max-w-full overflow-x-auto rounded-lg border bg-surface p-3 font-mono text-xs font-normal leading-5 text-foreground">
                  <code>{request.argumentsJson}</code>
                </pre>
              </section>

              <section className="grid gap-2 sm:grid-cols-2" aria-label="MCP call receipts">
                <div className="min-w-0 rounded-lg border bg-surface p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-secondary">
                    <Fingerprint className="size-3.5" aria-hidden="true" />
                    Arguments SHA-256
                  </p>
                  <p className="mt-1 break-all font-mono text-[10px] leading-4 text-tertiary">
                    {request.argumentsSha256}
                  </p>
                </div>
                <div className="min-w-0 rounded-lg border bg-surface p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-secondary">
                    <Fingerprint className="size-3.5" aria-hidden="true" />
                    Inventory SHA-256
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
                    <h3 className="text-sm font-medium">Server-defined operation</h3>
                    <p className="mt-1 text-sm font-normal leading-normal text-secondary">
                      SugarCode validates the frozen tool inventory and records
                      execution receipts, but the selected server owns the
                      operation and its external effects.
                    </p>
                  </div>
                </div>
              </section>
            </div>
          </ScrollArea>

          <AlertDialogFooter className="border-t bg-surface px-5 py-4 sm:items-center sm:px-6">
            <p className="mr-auto min-h-5 text-xs text-secondary" aria-live="polite">
              {store.actionError ? (
                <span className="text-destructive" role="alert">
                  {store.actionError}
                </span>
              ) : request.actionState === 'localWindowElapsed' ? (
                'The local window elapsed. Waiting for the durable outcome.'
              ) : submitting ? (
                'Recording the one-time decision…'
              ) : (
                'Deny is the default. Escape also denies.'
              )}
            </p>
            <AlertDialogCancel asChild>
              <Button
                ref={denyRef}
                type="button"
                variant="outline"
                disabled={!store.canApprove}
                onClick={() => void store.deny()}
              >
                Deny
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                disabled={!store.canApprove}
                onClick={() => void store.approve()}
              >
                Approve once
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
};

export const McpApprovalSurface = () =>
  typeof window.sugarcode?.getMcpApprovalState === 'function' ? (
    <McpApprovalSurfaceContent />
  ) : null;
