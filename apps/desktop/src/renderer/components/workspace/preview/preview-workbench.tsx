import { memo, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Square,
} from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';

import { useStore } from './use-store';

const previewStatusLabel = (
  status: ReturnType<typeof useStore>['state']['status'],
): string => {
  switch (status) {
    case 'opening':
      return '正在连接';
    case 'ready':
      return '实时';
    case 'failed':
      return '连接失败';
    default:
      return '未连接';
  }
};

type PreviewWorkbenchProps = Readonly<{
  active: boolean;
  onTitleChange?: (title: string) => void;
  previewId: string;
}>;

const PreviewWorkbenchView = ({
  active,
  onTitleChange,
  previewId,
}: PreviewWorkbenchProps) => {
  const store = useStore(previewId);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const setBoundsRef = useRef(store.setBounds);
  const onTitleChangeRef = useRef(onTitleChange);
  const ready = store.state.status === 'ready';
  const connected = store.state.status === 'opening' || ready;
  const workspaceReady = store.workspace.status === 'ready';
  const sessionId = connected ? store.state.sessionId : null;
  setBoundsRef.current = store.setBounds;
  onTitleChangeRef.current = onTitleChange;

  useEffect(() => {
    if (store.state.status === 'closed') {
      return;
    }
    try {
      onTitleChangeRef.current?.(new URL(store.state.url).host || '浏览器');
    } catch {
      onTitleChangeRef.current?.('浏览器');
    }
  }, [store.state]);

  useEffect(() => {
    if (!active || !connected) {
      void setBoundsRef.current(null);
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    let animationFrame = 0;
    const syncBounds = (): void => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const rect = viewport.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) {
          void setBoundsRef.current(null);
          return;
        }
        void setBoundsRef.current({
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        });
      });
    };
    const observer = new ResizeObserver(syncBounds);
    observer.observe(viewport);
    window.addEventListener('resize', syncBounds);
    window.addEventListener('scroll', syncBounds, true);
    syncBounds();
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
      window.removeEventListener('scroll', syncBounds, true);
      void setBoundsRef.current(null);
    };
  }, [active, connected, ready, sessionId]);

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-[#ffffff] text-[#202522]"
      aria-label="应用预览浏览器"
    >
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-[#dfe4e1] bg-[#f6f8f7] px-2.5">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="text-[#66706b] hover:bg-[#e8ecea] hover:text-[#202522]"
          disabled={!ready || store.busy || !store.state.canGoBack}
          onClick={() => void store.goBack()}
          aria-label="后退"
          title="后退"
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="text-[#66706b] hover:bg-[#e8ecea] hover:text-[#202522]"
          disabled={!ready || store.busy || !store.state.canGoForward}
          onClick={() => void store.goForward()}
          aria-label="前进"
          title="前进"
        >
          <ArrowRight aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="text-[#66706b] hover:bg-[#e8ecea] hover:text-[#202522]"
          disabled={!ready || store.busy}
          onClick={() => void store.reload()}
          aria-label="刷新"
          title="刷新"
        >
          <RefreshCw aria-hidden="true" />
        </Button>

        <form
          className="ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#d6dcd9] bg-white px-2.5 shadow-[inset_0_1px_2px_rgba(28,38,33,.04),0_1px_2px_rgba(28,38,33,.04)] focus-within:border-[#5b9b7b] focus-within:ring-2 focus-within:ring-[#5b9b7b]/10"
          onSubmit={(event) => {
            event.preventDefault();
            void store.navigate();
          }}
        >
          {connected ? (
            <LockKeyhole className="size-3.5 shrink-0 text-[#3b8b65]" aria-hidden="true" />
          ) : (
            <Globe2 className="size-3.5 shrink-0 text-[#8b9490]" aria-hidden="true" />
          )}
          <input
            aria-label="预览地址"
            className="h-8 min-w-0 flex-1 bg-transparent font-mono text-[11px] text-[#303633] outline-none placeholder:text-[#9da5a1]"
            value={store.url}
            onChange={(event) => store.setUrl(event.target.value)}
            placeholder="http://localhost:3000/"
            autoComplete="off"
            spellCheck={false}
            disabled={store.busy}
          />
        </form>

        <Button
          type="button"
          size="sm"
          className="h-8 shrink-0 bg-[#25312b] px-3 text-[11px] font-medium text-white shadow-sm hover:bg-[#36443d]"
          disabled={!workspaceReady || store.busy}
          onClick={() => void store.navigate()}
        >
          {store.state.status === 'opening' ? '连接中' : connected ? '前往' : '打开'}
        </Button>
        {connected ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="text-[#7a847f] hover:bg-[#e8ecea] hover:text-[#202522]"
            disabled={store.busy}
            onClick={() => void store.close()}
            aria-label="停止预览"
            title="停止预览"
          >
            <Square aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between border-b border-[#e2e6e4] bg-[#f9faf9] px-3 font-mono text-[9px] uppercase tracking-[0.14em] text-[#7d8782]">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              ready ? 'bg-[#439a70] shadow-[0_0_0_3px_rgba(67,154,112,.12)]' : 'bg-[#b2b9b5]'
            }`}
            aria-hidden="true"
          />
          {previewStatusLabel(store.state.status)}
          {connected ? (
            <span className="truncate text-[#9aa29e]">· {store.state.origin}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5" title="隔离的本地开发会话">
          <ShieldCheck className="size-3" aria-hidden="true" />
          Local only
        </span>
      </div>

      {connected ? (
        <div
          ref={viewportRef}
          className="relative min-h-0 flex-1 overflow-hidden bg-white"
          aria-label="网页预览画布"
        >
          {store.state.status === 'opening' ? (
            <div className="absolute inset-0 grid place-items-center bg-[#fbfcfb]">
              <div className="flex items-center gap-2.5 text-xs text-[#737d78]">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                正在连接本地开发服务…
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-[#fbfcfb] px-8">
          <div className="pointer-events-none absolute inset-0 opacity-[0.045] [background-image:linear-gradient(rgba(30,42,36,.7)_1px,transparent_1px),linear-gradient(90deg,rgba(30,42,36,.7)_1px,transparent_1px)] [background-size:32px_32px]" />
          <div className="relative max-w-sm text-center">
            <span className="mx-auto grid size-12 place-items-center rounded-2xl border border-[#dfe4e1] bg-white text-[#3f8f69] shadow-[0_14px_35px_rgba(35,50,42,.10)]">
              <Globe2 className="size-5" aria-hidden="true" />
            </span>
            <h2 className="mt-5 text-[15px] font-medium tracking-[-0.015em] text-[#222825]">
              在这里直接测试应用
            </h2>
            <p className="mt-2 text-xs leading-5 text-[#707a75]">
              启动本地开发服务，把地址粘贴到上方。页面脚本、路由和同源接口都会在这个隔离浏览器中真实运行。
            </p>
            <p className="mt-4 font-mono text-[10px] leading-4 text-[#9aa29e]">
              支持 localhost、127.0.0.1、::1 · 必须包含端口
            </p>
            {!workspaceReady ? (
              <p className="mt-3 text-xs text-[#a66342]">请先打开一个项目工作区。</p>
            ) : null}
            {store.state.status === 'failed' ? (
              <p className="mt-3 text-xs text-[#b64e49]">本地服务连接失败，请确认地址和开发服务器状态。</p>
            ) : null}
          </div>
        </div>
      )}

      {store.error ? (
        <p
          className="shrink-0 border-t border-[#ecc6c3] bg-[#fff4f3] px-3 py-2 text-[11px] leading-4 text-[#a94440]"
          role="alert"
        >
          {store.error}
        </p>
      ) : null}
    </section>
  );
};

export const PreviewWorkbench = memo(
  PreviewWorkbenchView,
  (previous, next) =>
    previous.active === next.active && previous.previewId === next.previewId,
);
