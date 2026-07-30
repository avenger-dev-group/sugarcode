import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  MonitorUp,
  RefreshCw,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';

import { useStore } from './use-store';

export const PreviewWorkbench = () => {
  const store = useStore();
  const ready = store.state.status === 'ready';
  const workspaceReady = store.workspace.status === 'ready';
  const label = ready ? 'Static preview active' : 'Static preview';

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-w-0 max-w-40"
        onClick={() => store.setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={store.open}
        title={label}
      >
        <MonitorUp aria-hidden="true" />
        <span className="truncate">{label}</span>
        {ready ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
        ) : null}
      </Button>

      {store.open ? (
        <aside
          className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[34rem] flex-col border-l bg-background shadow-[-24px_0_70px_var(--shadow-soft)] sm:inset-y-3 sm:right-3 sm:rounded-2xl sm:border"
          role="dialog"
          aria-modal="false"
          aria-label="Local preview workbench"
        >
          <header className="flex min-w-0 items-center gap-3 border-b px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-tertiary">
                Literal loopback
              </p>
              <p className="truncate text-sm font-medium">
                External static preview
              </p>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => store.setOpen(false)}
              aria-label="Close local preview workbench"
            >
              <X aria-hidden="true" />
            </Button>
          </header>

          <div className="flex min-h-0 flex-1 flex-col overflow-auto px-5 py-5">
            <div className="rounded-xl border bg-muted/35 p-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 rounded-lg border bg-background p-2 text-primary">
                  <ShieldCheck className="size-4" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-sm font-medium tracking-[-0.01em]">
                    Static content, one local origin
                  </h2>
                  <p className="mt-1.5 text-xs leading-5 text-secondary">
                    SugarCode displays HTML, styles, images, and same-origin
                    navigation from a server you started elsewhere. Page
                    scripts are disabled; other hosts, ports, writes,
                    downloads, popups, frames, permissions, and WebSockets are
                    blocked.
                  </p>
                </div>
              </div>
            </div>

            <label
              className="mt-6 font-mono text-[10px] uppercase tracking-[0.16em] text-tertiary"
              htmlFor="local-preview-url"
            >
              Local server URL
            </label>
            <Input
              id="local-preview-url"
              className="mt-2 font-mono text-xs"
              value={store.url}
              onChange={(event) => store.setUrl(event.target.value)}
              placeholder="http://127.0.0.1:3000/"
              autoComplete="off"
              spellCheck={false}
              disabled={store.busy}
              autoFocus
            />
            <p className="mt-2 text-xs leading-5 text-tertiary">
              Only explicit-port HTTP URLs on 127.0.0.1 or ::1 are accepted.
              Desktop Main asks again before any network request.
            </p>

            <Button
              type="button"
              className="mt-4 self-start"
              disabled={!workspaceReady || store.busy}
              onClick={() => void store.openLocalPreview()}
            >
              <MonitorUp aria-hidden="true" />
              {store.state.status === 'opening'
                ? 'Opening preview…'
                : ready
                  ? 'Replace preview'
                  : 'Open local preview'}
            </Button>
            {!workspaceReady ? (
              <p className="mt-3 text-xs text-secondary">
                Choose and finish opening a workspace first.
              </p>
            ) : null}

            {ready ? (
              <section
                className="mt-7 border-t pt-5"
                aria-label="Active local preview"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-tertiary">
                      Confirmed origin
                    </p>
                    <p
                      className="mt-1 truncate font-mono text-xs"
                      title={store.state.origin}
                    >
                      {store.state.origin}
                    </p>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] text-secondary">
                    {store.state.visible ? (
                      <Eye className="size-3" aria-hidden="true" />
                    ) : (
                      <EyeOff className="size-3" aria-hidden="true" />
                    )}
                    {store.state.visible ? 'Visible' : 'Hidden'}
                  </span>
                </div>
                <p
                  className="mt-3 break-all rounded-lg bg-muted px-3 py-2 font-mono text-[11px] leading-5 text-secondary"
                  title={store.state.url}
                >
                  {store.state.url}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={store.busy || !store.state.canGoBack}
                    onClick={() => void store.goBack()}
                  >
                    <ArrowLeft aria-hidden="true" />
                    Back
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={store.busy || !store.state.canGoForward}
                    onClick={() => void store.goForward()}
                  >
                    <ArrowRight aria-hidden="true" />
                    Forward
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={store.busy}
                    onClick={() => void store.reload()}
                  >
                    <RefreshCw aria-hidden="true" />
                    Reload
                  </Button>
                  {!store.state.visible ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={store.busy}
                      onClick={() => void store.show()}
                    >
                      <Eye aria-hidden="true" />
                      Show window
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={store.busy}
                    onClick={() => void store.close()}
                  >
                    <Square aria-hidden="true" />
                    Stop preview
                  </Button>
                </div>
              </section>
            ) : null}

            {store.error ? (
              <p className="mt-5 text-xs leading-5 text-destructive" role="alert">
                {store.error}
              </p>
            ) : null}
          </div>
        </aside>
      ) : null}
    </>
  );
};
