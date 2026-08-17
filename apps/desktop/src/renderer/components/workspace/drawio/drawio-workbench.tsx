import '@maxgraph/core/css/common.css';
import './drawio-workbench.css';

import {
  Graph,
  InternalEvent,
  ModelXmlSerializer,
  PanningHandler,
} from '@maxgraph/core';
import {
  Check,
  Copy,
  Focus,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { useStore as useWorkspaceDocumentStore } from '@/renderer/components/workspace/review/use-store';

import {
  isDrawioEdgeLinePath,
  isDrawioFlowAnimationValue,
  resolveDrawioFlowAnimation,
} from './drawio-animation';
import { copyDrawioSvgAsPng } from './drawio-copy-image';
import {
  clampDrawioScale,
  DRAWIO_MAX_SCALE,
  DRAWIO_MIN_SCALE,
  resolveDrawioFitScale,
} from './drawio-viewport';

type DiagramSummary = Readonly<{
  animatedEdges: number;
  cells: number;
  edges: number;
}>;

type CopyState = 'idle' | 'copying' | 'copied' | 'error';

const RESIZE_SETTLE_MS = 80;

const ORIGINAL_DASH_ATTRIBUTE = 'data-drawio-flow-original-dasharray';
const NO_DASH_VALUE = '__none__';

const clearFlowAnimations = (graph: Graph): void => {
  for (const path of graph.container.querySelectorAll<SVGPathElement>('.drawio-flow-path')) {
    const originalDashArray = path.getAttribute(ORIGINAL_DASH_ATTRIBUTE);
    if (originalDashArray === NO_DASH_VALUE) path.removeAttribute('stroke-dasharray');
    else if (originalDashArray !== null) path.setAttribute('stroke-dasharray', originalDashArray);
    path.classList.remove('drawio-flow-path');
    path.style.removeProperty('animation');
    path.style.removeProperty('stroke-dashoffset');
    path.removeAttribute(ORIGINAL_DASH_ATTRIBUTE);
  }
};

const updateFlowAnimations = (
  graph: Graph,
  enabled: boolean,
): void => {
  clearFlowAnimations(graph);
  if (!enabled) return;
  for (const cell of Object.values(graph.getDataModel().cells ?? {})) {
    if (!cell.isEdge()) continue;
    const style = cell.getStyle() as Record<string, unknown>;
    if (!isDrawioFlowAnimationValue(style.flowAnimation)) continue;
    const shape = graph.getView().getState(cell)?.shape?.node;
    if (!shape) continue;
    const paths = Array.from(shape.querySelectorAll('path'));
    const line = paths.find((candidate) =>
      isDrawioEdgeLinePath({
        data: candidate.getAttribute('d'),
        fill: candidate.getAttribute('fill'),
        stroke: candidate.getAttribute('stroke'),
        visibility: candidate.getAttribute('visibility'),
      }),
    );
    if (!line) continue;
    const originalDashArray = line.getAttribute('stroke-dasharray');
    const animation = resolveDrawioFlowAnimation({
      existingDashArray: originalDashArray,
      scale: graph.getView().getScale(),
      style,
    });
    line.setAttribute(
      ORIGINAL_DASH_ATTRIBUTE,
      originalDashArray ?? NO_DASH_VALUE,
    );
    line.setAttribute('stroke-dasharray', animation.dashArray);
    line.classList.add('drawio-flow-path');
    line.style.animation = `drawio-flow-path ${animation.durationMs}ms ${animation.timing} infinite ${animation.direction}`;
    line.style.strokeDashoffset = String(animation.offset);
  }
};

const parseXml = (source: string): XMLDocument => {
  const document = new DOMParser().parseFromString(source, 'application/xml');
  const error = document.querySelector('parsererror');
  if (error) {
    throw new Error(error.textContent?.trim() || 'Draw.io XML 无法解析。');
  }
  return document;
};

const extractGraphModel = (
  source: string,
): Readonly<{ xml: string; summary: DiagramSummary }> => {
  const document = parseXml(source);
  const root = document.documentElement;
  let model = root.tagName === 'mxGraphModel'
    ? root
    : root.getElementsByTagName('mxGraphModel').item(0);
  if (!model && root.tagName === 'mxfile') {
    const payload = root.getElementsByTagName('diagram').item(0)?.textContent?.trim();
    if (payload?.startsWith('<mxGraphModel')) {
      model = parseXml(payload).documentElement;
    }
  }
  if (!model || model.tagName !== 'mxGraphModel') {
    throw new Error('当前仅支持包含未压缩 mxGraphModel 的 Draw.io 文件。');
  }
  const cells = model.getElementsByTagName('mxCell');
  let animatedEdges = 0;
  let edges = 0;
  for (const cell of cells) {
    if (cell.getAttribute('edge') === '1') {
      edges += 1;
      if (/(?:^|;)flowAnimation=1(?:;|$)/u.test(cell.getAttribute('style') ?? '')) {
        animatedEdges += 1;
      }
    }
  }
  return {
    xml: new XMLSerializer().serializeToString(model),
    summary: { animatedEdges, cells: cells.length, edges },
  };
};

const DrawioWorkbenchView = ({
  active,
  path,
}: Readonly<{ active: boolean; path: string }>) => {
  const store = useWorkspaceDocumentStore(path);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const activeRef = useRef(active);
  const initialFitPendingRef = useRef(true);
  const motionEnabledRef = useRef(true);
  const copyResetTimerRef = useRef(0);
  const viewportRefreshTimerRef = useRef(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [summary, setSummary] = useState<DiagramSummary | null>(null);
  const [scale, setScale] = useState(100);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  activeRef.current = active;
  motionEnabledRef.current = motionEnabled;

  const syncScale = useCallback((graph: Graph): void => {
    setScale(Math.round(graph.getView().getScale() * 100));
  }, []);

  const fit = useCallback((): void => {
    const graph = graphRef.current;
    const container = canvasRef.current;
    if (!graph || !container || !activeRef.current) {
      return;
    }
    const view = graph.getView();
    let originalScale = view.getScale();
    if (!Number.isFinite(originalScale) || originalScale < DRAWIO_MIN_SCALE) {
      view.setScale(1);
      graph.refresh();
      originalScale = 1;
    }
    const bounds = graph.getGraphBounds();
    const graphWidth = bounds.width / originalScale;
    const graphHeight = bounds.height / originalScale;
    const nextScale = resolveDrawioFitScale({
      containerHeight: container.clientHeight,
      containerWidth: container.clientWidth,
      graphHeight,
      graphWidth,
    });
    if (nextScale === null) return;
    const translateX = Math.floor(
      view.getTranslate().x +
      (container.clientWidth - graphWidth * nextScale) / (2 * nextScale) -
      bounds.x / originalScale,
    );
    const translateY = Math.floor(
      view.getTranslate().y +
      (container.clientHeight - graphHeight * nextScale) / (2 * nextScale) -
      bounds.y / originalScale,
    );
    view.scaleAndTranslate(nextScale, translateX, translateY);
    initialFitPendingRef.current = false;
    syncScale(graph);
  }, [syncScale]);

  const scheduleViewportRefresh = useCallback((): void => {
    if (viewportRefreshTimerRef.current) {
      window.clearTimeout(viewportRefreshTimerRef.current);
    }
    viewportRefreshTimerRef.current = window.setTimeout(() => {
      viewportRefreshTimerRef.current = 0;
      const graph = graphRef.current;
      const container = canvasRef.current;
      if (!graph || !container || !activeRef.current) return;
      graph.refresh();
      updateFlowAnimations(graph, motionEnabledRef.current);
      const currentScale = graph.getView().getScale();
      if (
        initialFitPendingRef.current ||
        !Number.isFinite(currentScale) ||
        currentScale < DRAWIO_MIN_SCALE
      ) {
        fit();
      } else {
        syncScale(graph);
      }
    }, RESIZE_SETTLE_MS);
  }, [fit, syncScale]);

  const zoom = useCallback((direction: 'in' | 'out'): void => {
    const graph = graphRef.current;
    if (!graph) return;
    const current = clampDrawioScale(graph.getView().getScale());
    const next = direction === 'in'
      ? Math.min(DRAWIO_MAX_SCALE, current * graph.zoomFactor)
      : Math.max(DRAWIO_MIN_SCALE, current / graph.zoomFactor);
    graph.zoomTo(next, true);
    initialFitPendingRef.current = false;
    syncScale(graph);
  }, [syncScale]);

  const copyAsImage = useCallback(async (): Promise<void> => {
    const graph = graphRef.current;
    const svg = canvasRef.current?.querySelector('svg');
    if (!graph || !(svg instanceof SVGSVGElement)) return;
    if (copyResetTimerRef.current) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = 0;
    }
    setCopyState('copying');
    try {
      await copyDrawioSvgAsPng({
        bounds: graph.getGraphBounds(),
        svg,
        viewScale: graph.getView().getScale(),
      });
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      copyResetTimerRef.current = 0;
      setCopyState('idle');
    }, 2_000);
  }, []);

  useEffect(() => () => {
    if (copyResetTimerRef.current) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    if (viewportRefreshTimerRef.current) {
      window.clearTimeout(viewportRefreshTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const container = canvasRef.current;
    const document = store.document;
    if (
      !container ||
      !document ||
      document.status === 'error' ||
      document.status === 'truncated'
    ) {
      return;
    }
    let graph: Graph | null = null;
    let flowFrame = 0;
    let flowObserver: MutationObserver | null = null;
    let refreshFlowAnimations: (() => void) | null = null;
    try {
      const parsed = extractGraphModel(document.content);
      container.replaceChildren();
      InternalEvent.disableContextMenu(container);
      graph = new Graph(container);
      graphRef.current = graph;
      graph.setEnabled(false);
      graph.setCellsLocked(true);
      graph.setConnectable(false);
      graph.setHtmlLabels(false);
      graph.setPanning(true);
      graph.centerZoom = true;
      const panning = graph.getPlugin<PanningHandler>('PanningHandler');
      if (panning) {
        panning.useLeftButtonForPanning = true;
        panning.ignoreCell = true;
        panning.minScale = DRAWIO_MIN_SCALE;
        panning.maxScale = DRAWIO_MAX_SCALE;
        panning.setPanningEnabled(true);
      }
      graph.getView().rendering = false;
      new ModelXmlSerializer(graph.getDataModel()).import(parsed.xml);
      graph.getView().rendering = true;
      graph.refresh();
      const activeGraph = graph;
      const applyFlowAnimations = (): void => {
        updateFlowAnimations(activeGraph, motionEnabledRef.current);
      };
      refreshFlowAnimations = (): void => {
        if (flowFrame) return;
        flowFrame = window.requestAnimationFrame(() => {
          flowFrame = 0;
          applyFlowAnimations();
        });
      };
      flowObserver = new MutationObserver(refreshFlowAnimations);
      flowObserver.observe(container, { childList: true, subtree: true });
      graph.getView().addListener(InternalEvent.SCALE, refreshFlowAnimations);
      graph.getView().addListener(InternalEvent.TRANSLATE, refreshFlowAnimations);
      graph.getView().addListener(
        InternalEvent.SCALE_AND_TRANSLATE,
        refreshFlowAnimations,
      );
      graph.addListener(InternalEvent.PAN_END, refreshFlowAnimations);
      applyFlowAnimations();
      initialFitPendingRef.current = true;
      setSummary(parsed.summary);
      setRenderError(null);
      scheduleViewportRefresh();
    } catch (error) {
      setSummary(null);
      setRenderError(
        error instanceof Error ? error.message : 'Draw.io 图表渲染失败。',
      );
    }
    return () => {
      if (viewportRefreshTimerRef.current) {
        window.clearTimeout(viewportRefreshTimerRef.current);
        viewportRefreshTimerRef.current = 0;
      }
      if (flowFrame) window.cancelAnimationFrame(flowFrame);
      flowObserver?.disconnect();
      if (graph && refreshFlowAnimations) {
        graph.getView().removeListener(refreshFlowAnimations);
        graph.removeListener(refreshFlowAnimations);
      }
      if (graphRef.current === graph) graphRef.current = null;
      graph?.destroy();
      container.replaceChildren();
    };
  }, [scheduleViewportRefresh, store.document]);

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;
    let wheelFrame = 0;
    let wheelDelta = 0;
    const handleWheel = (event: WheelEvent): void => {
      const graph = graphRef.current;
      if (!graph || !active) return;
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 18
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? container.clientHeight
          : 1;
      wheelDelta += event.deltaY * unit;
      if (wheelFrame) return;
      wheelFrame = window.requestAnimationFrame(() => {
        wheelFrame = 0;
        const currentGraph = graphRef.current;
        if (!currentGraph) return;
        const factor = Math.exp(-wheelDelta * 0.0018);
        wheelDelta = 0;
        const current = clampDrawioScale(
          currentGraph.getView().getScale(),
        );
        const next = Math.min(
          DRAWIO_MAX_SCALE,
          Math.max(DRAWIO_MIN_SCALE, current * factor),
        );
        currentGraph.zoomTo(next, true);
        initialFitPendingRef.current = false;
        syncScale(currentGraph);
      });
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
      if (wheelFrame) window.cancelAnimationFrame(wheelFrame);
    };
  }, [active, syncScale]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    updateFlowAnimations(graph, motionEnabled);
  }, [motionEnabled]);

  useEffect(() => {
    if (!active) {
      if (viewportRefreshTimerRef.current) {
        window.clearTimeout(viewportRefreshTimerRef.current);
        viewportRefreshTimerRef.current = 0;
      }
      return;
    }
    scheduleViewportRefresh();
  }, [active, scheduleViewportRefresh]);

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (active) scheduleViewportRefresh();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [active, scheduleViewportRefresh]);

  const documentError =
    store.document?.status === 'error'
      ? `无法读取图表：${store.document.kind}`
      : store.document?.status === 'truncated'
        ? '图表文件过大，无法完整载入右侧画布。'
        : null;
  const error = store.error ?? documentError ?? renderError;

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#f8faf9]" aria-label={`Draw.io 画布：${path}`}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[#dfe5e2] bg-white/90 px-3">
        <span className="grid size-7 place-items-center rounded-lg bg-[#e9f4ee] text-[#287453]">
          <Workflow className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <code className="block truncate font-mono text-[11px] text-[#35413b]" title={path}>{path}</code>
          <span className="block text-[9px] uppercase tracking-[0.14em] text-[#8a9690]">
            {summary
              ? `${summary.cells} cells · ${summary.edges} edges · ${summary.animatedEdges} animated`
              : 'Native mxGraph XML'}
          </span>
        </span>
        <div className="flex items-center gap-0.5 rounded-lg border border-[#dfe5e2] bg-[#f7f9f8] p-0.5">
          <Button type="button" size="icon-xs" variant="ghost" onClick={() => zoom('out')} disabled={!summary} aria-label="缩小图表">
            <Minus aria-hidden="true" />
          </Button>
          <span className="w-10 text-center font-mono text-[9px] text-[#66736d]">{scale}%</span>
          <Button type="button" size="icon-xs" variant="ghost" onClick={() => zoom('in')} disabled={!summary} aria-label="放大图表">
            <Plus aria-hidden="true" />
          </Button>
          <Button type="button" size="icon-xs" variant="ghost" onClick={fit} disabled={!summary} aria-label="适应画布">
            <Focus aria-hidden="true" />
          </Button>
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant={motionEnabled ? 'secondary' : 'ghost'}
          onClick={() => setMotionEnabled((current) => !current)}
          disabled={!summary?.animatedEdges}
          aria-label={motionEnabled ? '关闭流动箭头' : '开启流动箭头'}
          aria-pressed={motionEnabled}
          title={motionEnabled ? '关闭流动箭头' : '开启流动箭头'}
        >
          <Sparkles aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant={copyState === 'copied' ? 'secondary' : 'ghost'}
          onClick={() => void copyAsImage()}
          disabled={!summary || copyState === 'copying'}
          aria-label={
            copyState === 'copied'
              ? '图片已复制'
              : copyState === 'error'
                ? '复制图片失败'
                : '复制为 PNG 图片'
          }
          title={
            copyState === 'copied'
              ? '图片已复制'
              : copyState === 'error'
                ? '复制失败，请重试'
                : '复制为图片'
          }
        >
          {copyState === 'copying' ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : copyState === 'copied' ? (
            <Check className="text-[#287453]" aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
        </Button>
        <Button type="button" size="icon-xs" variant="ghost" onClick={() => void store.reload()} disabled={store.loading} aria-label="重新读取图表">
          <RefreshCw aria-hidden="true" />
        </Button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(55,91,73,.055)_1px,transparent_1px),linear-gradient(90deg,rgba(55,91,73,.055)_1px,transparent_1px)] bg-[size:24px_24px]" />
        <div ref={canvasRef} className="drawio-canvas absolute inset-0 overflow-hidden bg-transparent" />
        {store.loading ? (
          <div className="absolute inset-0 grid place-items-center bg-[#f8faf9]/88" role="status">
            <span className="flex items-center gap-2 text-xs text-[#63716a]">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              正在读取 Draw.io 图表…
            </span>
          </div>
        ) : null}
        {error ? (
          <div className="absolute inset-0 grid place-items-center bg-[#f8faf9]/92 px-8" role="alert">
            <div className="max-w-sm rounded-2xl border border-[#e6cbc7] bg-[#fff7f5] px-5 py-4 text-center shadow-sm">
              <p className="text-sm font-medium text-[#953f38]">画布暂时无法显示</p>
              <p className="mt-1.5 text-xs leading-5 text-[#795e5a]">{error}</p>
            </div>
          </div>
        ) : null}
      </div>
      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-[#dfe5e2] bg-white/75 px-3 font-mono text-[9px] uppercase tracking-[0.12em] text-[#8a9690]">
        <span>Local renderer · read only</span>
        <span aria-live="polite">
          {copyState === 'copying'
            ? 'Rendering PNG…'
            : copyState === 'copied'
              ? 'PNG copied'
              : copyState === 'error'
                ? 'Copy failed'
                : 'Scroll to zoom · drag to pan'}
        </span>
      </footer>
    </section>
  );
};

export const DrawioWorkbench = memo(DrawioWorkbenchView);
