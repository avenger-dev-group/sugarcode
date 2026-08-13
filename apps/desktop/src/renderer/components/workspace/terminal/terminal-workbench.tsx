import '@xterm/xterm/css/xterm.css';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import {
  CirclePause,
  LoaderCircle,
  Plus,
  Square,
  SquareTerminal,
  X,
} from 'lucide-react';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
} from 'react';

import { Button } from '@/renderer/components/ui/button';
import type { TerminalOutputChunk } from '@/shared/terminal';

import {
  shouldAutoStartTerminal,
  terminalStatusLabel,
} from './presentation';
import type { TerminalWorkbenchProps } from './types';
import { useStore } from './use-store';

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const INPUT_CHUNK_BYTES = 16_384;
const TERMINAL_SHORTCUT = 'Ctrl/⌘+Shift+`';

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

export const TerminalWorkbench = ({
  navigatorOffset,
}: TerminalWorkbenchProps) => {
  const store = useStore();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const renderedThroughRef = useRef<number>(0);
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const initializationRef = useRef<Promise<void> | null>(null);
  const terminalCleanupRef = useRef<(() => void) | null>(null);
  const inputActionRef = useRef(store.input);
  const resizeActionRef = useRef(store.resize);
  const refreshActionRef = useRef(store.refresh);
  const openRef = useRef<boolean>(store.open);
  const autoStartGenerationRef = useRef<number | null>(null);
  const state = store.state;
  const active = state.status !== 'closed';
  const live =
    state.status === 'starting' ||
    state.status === 'running' ||
    state.status === 'paused';
  const workspaceReady = store.workspace.status === 'ready';
  openRef.current = store.open;
  inputActionRef.current = store.input;
  resizeActionRef.current = store.resize;
  refreshActionRef.current = store.refresh;

  const enqueueInput = useCallback(
    (data: string): void => {
      for (const chunk of splitBoundedInput(data)) {
        inputQueueRef.current = inputQueueRef.current.then(() =>
          inputActionRef.current(chunk),
        );
      }
    },
    [],
  );

  useEffect(() => {
    if (
      !store.open ||
      terminalRef.current ||
      initializationRef.current
    ) {
      return;
    }
    const host = hostRef.current;
    if (!host) {
      return;
    }
    let active = true;
    initializationRef.current = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      if (!active || terminalRef.current) {
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
        lineHeight: 1.22,
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
        void resizeActionRef.current(cols, rows);
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
        if (openRef.current && host.clientWidth > 0 && host.clientHeight > 0) {
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
      void refreshActionRef.current();

      terminalCleanupRef.current = (): void => {
        themeObserver.disconnect();
        resizeObserver.disconnect();
        resizeSubscription.dispose();
        dataSubscription.dispose();
        terminal.dispose();
        terminalRef.current = null;
        fitRef.current = null;
        terminalCleanupRef.current = null;
      };
      if (openRef.current) {
        fit.fit();
        terminal.focus();
      }
    }).finally(() => {
      initializationRef.current = null;
    });
    return () => {
      active = false;
    };
  }, [enqueueInput, store.open]);

  useEffect(
    () => () => {
      terminalCleanupRef.current?.();
    },
    [],
  );

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
    terminal.options.cursorBlink =
      store.open &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, [state.status, store.open]);

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

  const create = useCallback(async (): Promise<void> => {
    const terminal = terminalRef.current;
    const columns = terminal?.cols ?? DEFAULT_COLUMNS;
    const rows = terminal?.rows ?? DEFAULT_ROWS;
    await store.create(columns, rows);
    terminal?.focus();
  }, [store.create]);

  useEffect(() => {
    if (!store.open) {
      autoStartGenerationRef.current = null;
      return undefined;
    }
    if (
      !shouldAutoStartTerminal({
        attemptedGeneration: autoStartGenerationRef.current,
        busy: store.busy,
        open: store.open,
        status: state.status,
        workspaceGeneration: store.workspace.generation,
        workspaceReady,
      })
    ) {
      return undefined;
    }
    autoStartGenerationRef.current = store.workspace.generation;
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit();
      void create();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    create,
    state.status,
    store.busy,
    store.open,
    store.workspace.generation,
    workspaceReady,
  ]);

  const statusLabel =
    store.busy && state.status === 'closed'
      ? '正在确认'
      : terminalStatusLabel(state);
  const statusTone =
    state.status === 'running'
      ? 'text-success'
      : state.status === 'paused'
        ? 'text-warning'
        : state.status === 'failed'
          ? 'text-destructive'
          : state.status === 'starting' || store.busy
            ? 'text-process'
            : 'text-tertiary';
  const panelStyle = {
    '--terminal-panel-left': `${navigatorOffset}px`,
  } as CSSProperties & Readonly<Record<'--terminal-panel-left', string>>;

  return (
    <>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className={`window-no-drag relative ml-auto text-tertiary ${
          store.open ? 'bg-surface text-foreground' : ''
        }`}
        onClick={() => store.setOpen(!store.open)}
        aria-controls="local-terminal-workbench"
        aria-haspopup="dialog"
        aria-expanded={store.open}
        aria-label={store.open ? '收起终端' : '打开终端'}
        title={`${store.open ? '收起终端' : '打开终端'} (${TERMINAL_SHORTCUT})`}
      >
        <SquareTerminal aria-hidden="true" />
        {live ? (
          <span
            className="absolute right-1 top-1 size-1.5 rounded-full bg-success ring-2 ring-background"
            aria-hidden="true"
          />
        ) : null}
      </Button>

      <section
        id="local-terminal-workbench"
        style={panelStyle}
        className={`fixed right-0 bottom-0 left-0 z-30 flex h-[min(46vh,32rem)] min-h-64 flex-col overflow-hidden border-t bg-background shadow-[0_-20px_60px_var(--shadow-soft)] transition-[transform,left] duration-200 ease-out md:left-[var(--terminal-panel-left)] motion-reduce:transition-none ${
          store.open
            ? 'translate-y-0'
            : 'pointer-events-none translate-y-full'
        }`}
        role="dialog"
        aria-modal="false"
        aria-label="Local terminal workbench"
        aria-hidden={!store.open}
        inert={store.open ? undefined : true}
      >
        <header className="flex h-11 min-w-0 shrink-0 items-center gap-2 border-b px-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface text-secondary">
            <SquareTerminal className="size-3.5" aria-hidden="true" />
          </span>
          <span className="shrink-0 text-sm font-medium">终端</span>
          {active ? (
            <span
              className="min-w-0 truncate text-xs text-tertiary"
              title={`${state.workspaceName}${state.shell ? ` · ${state.shell}` : ''}`}
            >
              {state.workspaceName}
              {state.shell ? ` · ${state.shell}` : ''}
            </span>
          ) : null}
          <span
            className={`ml-auto inline-flex shrink-0 items-center gap-1.5 px-1.5 text-xs ${statusTone}`}
          >
            {state.status === 'paused' ? (
              <CirclePause className="size-3" aria-hidden="true" />
            ) : state.status === 'starting' || store.busy ? (
              <LoaderCircle
                className="size-3 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <span
                className="size-1.5 rounded-full bg-current"
                aria-hidden="true"
              />
            )}
            {statusLabel}
          </span>
          {live ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-tertiary hover:text-destructive"
              disabled={store.busy}
              onClick={() => void store.terminate()}
              aria-label="停止终端"
              title="停止终端"
            >
              <Square aria-hidden="true" />
            </Button>
          ) : active ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={!workspaceReady || store.busy}
              onClick={() => void create()}
              aria-label="新建终端"
              title="新建终端"
            >
              <Plus aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => store.setOpen(false)}
            aria-label="收起终端"
            title="收起终端"
          >
            <X aria-hidden="true" />
          </Button>
        </header>

        <div className="relative min-h-0 flex-1 bg-background">
          <div
            ref={hostRef}
            className="absolute inset-0 px-4 py-3"
            aria-label="Interactive terminal"
          />
          {!active ? (
            <div className="absolute inset-0 z-10 grid place-items-center bg-background px-6 text-center">
              <div className="max-w-sm">
                <span className="mx-auto grid size-10 place-items-center rounded-xl border bg-surface text-tertiary">
                  {store.busy ? (
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <SquareTerminal className="size-4" aria-hidden="true" />
                  )}
                </span>
                <p className="mt-3 text-sm font-medium">
                  {!workspaceReady
                    ? '打开工作区后可使用终端'
                    : store.busy
                      ? '正在启动终端…'
                      : '终端尚未启动'}
                </p>
                {workspaceReady && !store.busy ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-4"
                    onClick={() => void create()}
                  >
                    <SquareTerminal aria-hidden="true" />
                    启动终端
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {state.status === 'paused' ? (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 border-b bg-background/95 px-4 py-2 text-xs text-secondary">
              Desktop Main 正在处理确认或等待队列，终端输入已暂停。
            </div>
          ) : null}
        </div>

        <footer className="flex min-h-8 shrink-0 items-center gap-3 overflow-hidden border-t px-4 font-mono text-[10px] text-tertiary">
          <span className="shrink-0">{TERMINAL_SHORTCUT} 显示/隐藏</span>
          <span className="hidden shrink-0 lg:inline">Ctrl+C 发送信号</span>
          <span className="hidden shrink-0 xl:inline">
            Ctrl+Shift+C/V 复制/粘贴
          </span>
          {store.error ? (
            <span
              className="ml-auto min-w-0 truncate font-sans text-xs text-destructive"
              role="alert"
              title={store.error}
            >
              {store.error}
            </span>
          ) : null}
        </footer>
      </section>
    </>
  );
};
