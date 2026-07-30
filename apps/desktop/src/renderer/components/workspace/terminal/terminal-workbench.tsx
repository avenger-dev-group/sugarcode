import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  AlertTriangle,
  CirclePause,
  Square,
  SquareTerminal,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
} from 'react';

import { Button } from '@/renderer/components/ui/button';
import type { TerminalOutputChunk } from '@/shared/terminal';

import { useStore } from './use-store';

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const INPUT_CHUNK_BYTES = 16_384;

const readTheme = (): Readonly<{
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}> => {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue('--background').trim(),
    foreground: styles.getPropertyValue('--foreground').trim(),
    cursor: styles.getPropertyValue('--foreground').trim(),
    selectionBackground: styles.getPropertyValue('--surface-hover').trim(),
  };
};

const splitBoundedInput = (data: string): string[] => {
  const encoder = new TextEncoder();
  if (encoder.encode(data).byteLength <= INPUT_CHUNK_BYTES) {
    return [data];
  }
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const scalar of data) {
    const scalarBytes = encoder.encode(scalar).byteLength;
    if (bytes + scalarBytes > INPUT_CHUNK_BYTES && current) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += scalar;
    bytes += scalarBytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
};

export const TerminalWorkbench = () => {
  const store = useStore();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const renderedThroughRef = useRef(0);
  const inputQueueRef = useRef(Promise.resolve());
  const state = store.state;
  const active = state.status !== 'closed';
  const live =
    state.status === 'starting' ||
    state.status === 'running' ||
    state.status === 'paused';
  const workspaceReady = store.workspace.status === 'ready';

  const enqueueInput = useCallback(
    (data: string): void => {
      for (const chunk of splitBoundedInput(data)) {
        inputQueueRef.current = inputQueueRef.current.then(() =>
          store.input(chunk),
        );
      }
    },
    [store.input],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: !reducedMotion,
      cursorStyle: 'bar',
      disableStdin: true,
      drawBoldTextInBrightColors: false,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.18,
      scrollback: 5_000,
      smoothScrollDuration: reducedMotion ? 0 : 80,
      theme: readTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const dataSubscription = terminal.onData(enqueueInput);
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      void store.resize(cols, rows);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      const copy =
        (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
        event.code === 'KeyC';
      if (copy && terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }
      const paste =
        (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
        event.code === 'KeyV';
      if (paste) {
        void navigator.clipboard
          .readText()
          .then(enqueueInput)
          .catch((): undefined => undefined);
        return false;
      }
      return true;
    });
    const resizeObserver = new ResizeObserver(() => {
      if (store.open && host.clientWidth > 0 && host.clientHeight > 0) {
        fit.fit();
      }
    });
    resizeObserver.observe(host);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = readTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    void store.refresh();
    return () => {
      themeObserver.disconnect();
      resizeObserver.disconnect();
      resizeSubscription.dispose();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || state.output.length === 0) {
      return;
    }
    const chunks: TerminalOutputChunk[] = [];
    for (const chunk of state.output) {
      if (chunk.sequence > renderedThroughRef.current) {
        chunks.push(chunk);
      }
    }
    if (chunks.length === 0) {
      return;
    }
    terminal.write(chunks.map((chunk) => chunk.data).join(''));
    const sequence = chunks[chunks.length - 1].sequence;
    renderedThroughRef.current = sequence;
    void store.acknowledge(sequence);
  }, [state.output, store.acknowledge]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    terminal.options.disableStdin = state.status !== 'running';
  }, [state.status]);

  useEffect(() => {
    if (!store.open) {
      return;
    }
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      terminalRef.current?.focus();
    });
  }, [store.open]);

  useEffect(() => {
    if (state.status === 'closed') {
      renderedThroughRef.current = 0;
      terminalRef.current?.reset();
    }
  }, [state.status]);

  useEffect(() => {
    renderedThroughRef.current = 0;
    terminalRef.current?.reset();
  }, [state.status === 'closed' ? undefined : state.sessionId]);

  const openTerminal = (): void => {
    store.setOpen(true);
  };

  const create = async (): Promise<void> => {
    const terminal = terminalRef.current;
    const columns = terminal?.cols ?? DEFAULT_COLUMNS;
    const rows = terminal?.rows ?? DEFAULT_ROWS;
    await store.create(columns, rows);
    terminal?.focus();
  };

  const label = live ? 'Terminal active' : 'Terminal';
  const statusLabel =
    state.status === 'paused'
      ? 'Input paused'
      : state.status === 'running'
        ? 'Interactive'
        : state.status === 'starting'
          ? 'Starting'
          : state.status === 'exited'
            ? `Exited ${state.exitCode}`
            : state.status === 'failed'
              ? 'Failed'
              : 'Closed';

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-w-0 max-w-36"
        onClick={openTerminal}
        aria-haspopup="dialog"
        aria-expanded={store.open}
        title={`${label} (Ctrl/⌘+Shift+\`)`}
      >
        <SquareTerminal aria-hidden="true" />
        <span className="truncate">{label}</span>
        {live ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
        ) : null}
      </Button>

      <section
        className={`fixed inset-x-0 bottom-0 z-30 flex h-[min(48vh,34rem)] min-h-64 flex-col border-t bg-background shadow-[0_-20px_60px_var(--shadow-soft)] transition-transform duration-150 motion-reduce:transition-none ${
          store.open
            ? 'translate-y-0'
            : 'pointer-events-none translate-y-full'
        }`}
        role="dialog"
        aria-modal="false"
        aria-label="Local terminal workbench"
        aria-hidden={!store.open}
      >
        <header className="flex min-w-0 items-center gap-3 border-b px-4 py-2.5">
          <span className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-tertiary">
            <AlertTriangle className="size-3.5 text-destructive" aria-hidden="true" />
            Real local shell
          </span>
          <span className="h-4 w-px bg-border" aria-hidden="true" />
          <span className="min-w-0 truncate text-xs text-secondary">
            {active ? state.workspaceName : 'No session'}
            {active && state.shell ? ` · ${state.shell}` : ''}
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-secondary">
            {state.status === 'paused' ? (
              <CirclePause className="size-3" aria-hidden="true" />
            ) : null}
            {statusLabel}
          </span>
          {live ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={store.busy}
              onClick={() => void store.terminate()}
            >
              <Square aria-hidden="true" />
              Stop
            </Button>
          ) : active ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!workspaceReady || store.busy}
              onClick={() => void create()}
            >
              <SquareTerminal aria-hidden="true" />
              New shell
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => store.setOpen(false)}
            aria-label="Close terminal workbench"
          >
            <X aria-hidden="true" />
          </Button>
        </header>

        <div className="relative min-h-0 flex-1 bg-background">
          <div
            ref={hostRef}
            className="absolute inset-0 px-3 py-2"
            aria-label="Interactive terminal"
          />
          {!active ? (
            <div className="absolute inset-0 z-10 grid place-items-center bg-background/95 px-6">
              <div className="max-w-lg border-l-2 border-destructive pl-4">
                <p className="text-sm font-medium">
                  This opens your account&apos;s real default shell.
                </p>
                <p className="mt-1.5 text-xs leading-5 text-secondary">
                  It is not the Agent sandbox. Commands can read and write
                  accessible files, use the network, and run arbitrary local
                  programs. Desktop Main will ask for native confirmation.
                </p>
                <Button
                  type="button"
                  className="mt-4"
                  disabled={!workspaceReady || store.busy}
                  onClick={() => void create()}
                >
                  <SquareTerminal aria-hidden="true" />
                  Open real shell
                </Button>
                {!workspaceReady ? (
                  <p className="mt-2 text-xs text-tertiary">
                    Choose and finish opening a workspace first.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
          {state.status === 'paused' ? (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 border-b bg-background/95 px-4 py-2 text-xs text-secondary">
              Terminal input is paused by Desktop Main while an approval or
              bounded queue is active.
            </div>
          ) : null}
        </div>

        <footer className="flex min-h-8 items-center border-t px-4 font-mono text-[9px] uppercase tracking-[0.12em] text-tertiary">
          Ctrl/⌘+Shift+` toggles · Ctrl+C signals unless text is selected ·
          Ctrl+Shift+C/V copies and pastes
          {store.error ? (
            <span
              className="ml-auto normal-case tracking-normal text-destructive"
              role="alert"
            >
              {store.error}
            </span>
          ) : null}
        </footer>
      </section>
    </>
  );
};
