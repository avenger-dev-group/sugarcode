import { graphlib, layout as dagreLayout } from '@dagrejs/dagre';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Handle,
  Panel,
  Position,
  ReactFlow,
  getSmoothStepPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Rect,
} from '@xyflow/react';
import {
  Binoculars,
  Check,
  Circle,
  Clock3,
  FilePenLine,
  Focus,
  GitBranch,
  LockKeyhole,
  Minus,
  Network,
  Plus,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useRef, type RefObject } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { cn } from '@/renderer/utils/class-name';

import type {
  AgentTaskRole,
  AgentTaskViewModel,
  OrchestrationActivityViewModel,
} from './types';
import { formatAgentTaskDuration } from './presentation';
import { useOrchestrationStore } from './use-store';
import { calculateVisibleGraphViewport } from './viewport';

const ROOT_NODE_WIDTH = 188;
const ROOT_NODE_HEIGHT = 72;
const AGENT_NODE_WIDTH = 220;
const AGENT_NODE_TITLE_WIDTH = 196;
const AGENT_NODE_CHROME_HEIGHT = 76;
const AGENT_NODE_TITLE_LINE_HEIGHT = 16;
const ROOT_NODE_ID = 'main-agent';
const GRAPH_MIN_ZOOM = 0.45;
const GRAPH_MAX_ZOOM = 1.6;
const GRAPH_FIT_PADDING = 0.2;

let titleMeasurementContext: CanvasRenderingContext2D | null | undefined;

const getTitleMeasurementContext = (): CanvasRenderingContext2D | null => {
  if (titleMeasurementContext !== undefined) {
    return titleMeasurementContext;
  }
  titleMeasurementContext = document
    .createElement('canvas')
    .getContext('2d');
  if (titleMeasurementContext) {
    titleMeasurementContext.font =
      '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  }
  return titleMeasurementContext;
};

const titleLineCount = (title: string): number => {
  const graphemes = Array.from(title);
  const context = getTitleMeasurementContext();
  if (!context) {
    return Math.max(1, Math.ceil(graphemes.length / 18));
  }
  let lines = 1;
  let line = '';
  for (const grapheme of graphemes) {
    if (grapheme === '\n') {
      lines += 1;
      line = '';
      continue;
    }
    const candidate = `${line}${grapheme}`;
    if (
      line.length > 0 &&
      context.measureText(candidate).width > AGENT_NODE_TITLE_WIDTH
    ) {
      lines += 1;
      line = grapheme.trimStart();
    } else {
      line = candidate;
    }
  }
  return lines;
};

const agentNodeHeight = (title: string): number =>
  AGENT_NODE_CHROME_HEIGHT +
  titleLineCount(title) * AGENT_NODE_TITLE_LINE_HEIGHT;

type AgentNodeData = {
  kind: 'agent';
  task: AgentTaskViewModel;
  onSelect: (task: AgentTaskViewModel) => void;
};

type RootNodeData = {
  kind: 'root';
};

type OrchestrationNode = Node<
  AgentNodeData | RootNodeData,
  'orchestrationNode'
>;

type OrchestrationEdge = Edge<{ active: boolean }, 'orchestrationEdge'>;

const STATUS_LABELS: Record<AgentTaskViewModel['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  waitingApproval: 'Waiting for approval',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};

const STATUS_TONES: Record<AgentTaskViewModel['status'], string> = {
  queued: 'border-border bg-surface text-tertiary',
  running: 'border-primary/25 bg-surface text-primary',
  waitingApproval: 'border-primary/25 bg-surface text-process',
  completed: 'border-border bg-surface text-secondary',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  interrupted: 'border-border bg-surface text-secondary',
  cancelled: 'border-border bg-surface text-tertiary',
};

const ROLE_LABELS: Record<AgentTaskRole, string> = {
  explorer: 'Explorer',
  worker: 'Worker',
  auditor: 'Auditor',
};

const RoleIcon = ({ role }: Readonly<{ role: AgentTaskRole }>) => {
  switch (role) {
    case 'explorer':
      return <Binoculars aria-hidden="true" />;
    case 'worker':
      return <FilePenLine aria-hidden="true" />;
    case 'auditor':
      return <ShieldCheck aria-hidden="true" />;
  }
};

const StatusIcon = ({
  status,
}: Readonly<{ status: AgentTaskViewModel['status'] }>) => {
  switch (status) {
    case 'completed':
      return <Check aria-hidden="true" />;
    case 'failed':
    case 'interrupted':
    case 'cancelled':
      return <TriangleAlert aria-hidden="true" />;
    case 'running':
    case 'waitingApproval':
      return <Sparkles aria-hidden="true" />;
    case 'queued':
      return <Circle aria-hidden="true" />;
  }
};

const OrchestrationNodeView = ({
  data,
  selected,
}: NodeProps<OrchestrationNode>) => {
  if (data.kind === 'root') {
    return (
      <div className="relative flex h-[72px] w-[188px] items-center gap-3 overflow-hidden rounded-[14px] border border-primary/25 bg-background px-3.5 shadow-[0_12px_32px_var(--shadow-soft)]">
        <span
          className="absolute inset-x-0 top-0 h-px bg-primary/35"
          aria-hidden="true"
        />
        <span className="flex size-9 items-center justify-center rounded-[10px] bg-primary text-primary-foreground shadow-sm">
          <Sparkles className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-tertiary">
            Orchestrator
          </p>
          <p className="mt-1 text-[13px] font-medium">Main Agent</p>
        </div>
        <Handle
          type="source"
          position={Position.Bottom}
          className="!size-1.5 !border-0 !bg-primary/40"
        />
      </div>
    );
  }

  const { task } = data;
  const height = agentNodeHeight(task.title);
  const dependencyLabel =
    task.dependsOn.length === 0
      ? 'Root'
      : `${task.dependsOn.length} ${
          task.dependsOn.length === 1 ? 'dep' : 'deps'
        }`;
  return (
    <button
      type="button"
      onClick={() => data.onSelect(task)}
      className={cn(
        'nodrag pointer-events-auto relative flex w-[220px] cursor-pointer flex-col overflow-hidden rounded-[14px] border bg-background text-left shadow-[0_10px_28px_var(--shadow-soft)] transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-[0_14px_34px_var(--shadow-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transform-none motion-reduce:transition-none',
        selected &&
          'border-primary/55 ring-2 ring-primary/10 shadow-[0_16px_38px_var(--shadow-soft)]',
      )}
      style={{ height }}
      aria-label={`${ROLE_LABELS[task.role]} ${task.title}, ${STATUS_LABELS[task.status]}`}
      aria-pressed={selected}
      title={task.title}
      data-agent-status={task.status}
      data-agent-selected={selected}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!size-1.5 !border-0 !bg-primary/40"
      />
      <div className="flex h-10 w-full min-w-0 items-center gap-2 px-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-surface [&>svg]:size-3.5">
          <RoleIcon role={task.role} />
        </span>
        <span className="truncate font-mono text-[9px] uppercase tracking-[0.14em] text-tertiary">
          {ROLE_LABELS[task.role]}
        </span>
        <span
          className={cn(
            'ml-auto flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] [&>svg]:size-2.5',
            STATUS_TONES[task.status],
          )}
        >
          <StatusIcon status={task.status} />
          {STATUS_LABELS[task.status]}
        </span>
      </div>
      <div className="w-full px-3 pt-2">
        <span className="block w-full break-words text-[12px] font-medium leading-4 text-primary">
          {task.title}
        </span>
      </div>
      <div className="mt-auto flex h-7 w-full items-center gap-2 border-t px-3 font-mono text-[8px] uppercase tracking-[0.08em] text-tertiary">
        <span className="flex min-w-0 items-center gap-1">
          <LockKeyhole className="size-2.5 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {task.access === 'readOnly' ? 'Read only' : 'Workspace write'}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <GitBranch className="size-2.5" aria-hidden="true" />
          {dependencyLabel}
        </span>
        {task.result ? (
          <span className="flex shrink-0 items-center gap-1">
            <Clock3 className="size-2.5" aria-hidden="true" />
            {formatAgentTaskDuration(task.result.durationMs)}
          </span>
        ) : null}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!size-1.5 !border-0 !bg-primary/40"
      />
    </button>
  );
};

const OrchestrationEdgeView = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<OrchestrationEdge>) => {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  });

  return (
    <BaseEdge
      path={path}
      className={
        data?.active
          ? 'orchestration-edge orchestration-edge--active'
          : 'orchestration-edge'
      }
    />
  );
};

const nodeTypes = { orchestrationNode: OrchestrationNodeView };
const edgeTypes = { orchestrationEdge: OrchestrationEdgeView };

const layoutGraph = (
  activity: OrchestrationActivityViewModel,
  onSelect: (task: AgentTaskViewModel) => void,
  selectedTaskId: string | undefined,
): Readonly<{
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  bounds: Rect;
}> => {
  const graph = new graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: 'TB',
    ranksep: 50,
    nodesep: 32,
    marginx: 24,
    marginy: 18,
  });
  graph.setNode(ROOT_NODE_ID, {
    width: ROOT_NODE_WIDTH,
    height: ROOT_NODE_HEIGHT,
  });

  const taskByKey = new Map(
    activity.tasks.map((task) => [task.clientTaskKey, task]),
  );
  const taskHeights = new Map(
    activity.tasks.map((task) => [task.taskId, agentNodeHeight(task.title)]),
  );
  for (const task of activity.tasks) {
    graph.setNode(task.taskId, {
      width: AGENT_NODE_WIDTH,
      height: taskHeights.get(task.taskId),
    });
    if (task.dependsOn.length === 0) {
      graph.setEdge(ROOT_NODE_ID, task.taskId);
      continue;
    }
    for (const dependencyKey of task.dependsOn) {
      const dependency = taskByKey.get(dependencyKey);
      if (dependency) {
        graph.setEdge(dependency.taskId, task.taskId);
      }
    }
  }
  dagreLayout(graph);

  const nodes: OrchestrationNode[] = [
    {
      id: ROOT_NODE_ID,
      type: 'orchestrationNode',
      data: { kind: 'root' },
      position: {
        x: graph.node(ROOT_NODE_ID).x - ROOT_NODE_WIDTH / 2,
        y: graph.node(ROOT_NODE_ID).y - ROOT_NODE_HEIGHT / 2,
      },
      width: ROOT_NODE_WIDTH,
      height: ROOT_NODE_HEIGHT,
      selectable: false,
      draggable: false,
      focusable: false,
    },
    ...activity.tasks.map((task): OrchestrationNode => {
      const position = graph.node(task.taskId);
      const height = taskHeights.get(task.taskId) ?? AGENT_NODE_CHROME_HEIGHT;
      return {
        id: task.taskId,
        type: 'orchestrationNode',
        data: { kind: 'agent', task, onSelect },
        position: {
          x: position.x - AGENT_NODE_WIDTH / 2,
          y: position.y - height / 2,
        },
        width: AGENT_NODE_WIDTH,
        height,
        selectable: false,
        draggable: false,
        focusable: true,
        selected: task.taskId === selectedTaskId,
        ariaLabel: `${ROLE_LABELS[task.role]} ${task.title}`,
      };
    }),
  ];

  const edges: OrchestrationEdge[] = [];
  for (const task of activity.tasks) {
    const sources =
      task.dependsOn.length === 0
        ? [ROOT_NODE_ID]
        : task.dependsOn
            .map((key) => taskByKey.get(key)?.taskId)
            .filter((taskId): taskId is string => Boolean(taskId));
    for (const source of sources) {
      edges.push({
        id: `${source}:${task.taskId}`,
        source,
        target: task.taskId,
        type: 'orchestrationEdge',
        data: {
          active:
            task.status === 'running' ||
            task.status === 'waitingApproval',
        },
      });
    }
  }
  const left = Math.min(...nodes.map((node) => node.position.x));
  const top = Math.min(...nodes.map((node) => node.position.y));
  const right = Math.max(
    ...nodes.map((node) => node.position.x + (node.width ?? 0)),
  );
  const bottom = Math.max(
    ...nodes.map((node) => node.position.y + (node.height ?? 0)),
  );
  return {
    nodes,
    edges,
    bounds: {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    },
  };
};

const fitGraphToVisibleArea = (
  flow: ReactFlowInstance<OrchestrationNode, OrchestrationEdge>,
  element: HTMLDivElement,
  bounds: Rect,
  duration: number,
): Promise<boolean> => {
  const containerRect = element.getBoundingClientRect();
  const clipElement = element.closest<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  );
  const clipRect = clipElement?.getBoundingClientRect();
  const visibleLeft = Math.max(
    containerRect.left,
    clipRect?.left ?? containerRect.left,
  );
  const visibleRight = Math.min(
    containerRect.right,
    clipRect?.right ?? containerRect.right,
  );
  const viewport = calculateVisibleGraphViewport({
    bounds,
    containerWidth: containerRect.width,
    containerHeight: containerRect.height,
    visibleLeft: visibleLeft - containerRect.left,
    visibleRight: visibleRight - containerRect.left,
    minZoom: GRAPH_MIN_ZOOM,
    maxZoom: GRAPH_MAX_ZOOM,
    padding: GRAPH_FIT_PADDING,
  });
  if (!viewport) {
    return Promise.resolve(false);
  }
  return flow.setViewport(viewport, { duration });
};

const GraphControls = ({
  container,
  bounds,
}: Readonly<{
  container: RefObject<HTMLDivElement | null>;
  bounds: Rect;
}>) => {
  const flow = useReactFlow<OrchestrationNode, OrchestrationEdge>();
  return (
    <Panel
      position="top-left"
      className="!m-3 flex items-center gap-0.5 rounded-[10px] border bg-background/90 p-1 shadow-sm backdrop-blur"
    >
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6"
        onClick={() => void flow.zoomIn({ duration: 120 })}
        aria-label="Zoom orchestration in"
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6"
        onClick={() => void flow.zoomOut({ duration: 120 })}
        aria-label="Zoom orchestration out"
      >
        <Minus className="size-3.5" aria-hidden="true" />
      </Button>
      <span className="mx-0.5 h-3.5 w-px bg-border" aria-hidden="true" />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6"
        onClick={() => {
          const element = container.current;
          if (element) {
            void fitGraphToVisibleArea(flow, element, bounds, 160);
          }
        }}
        aria-label="Fit orchestration to view"
      >
        <Focus className="size-3.5" aria-hidden="true" />
      </Button>
    </Panel>
  );
};

const GraphAutoFit = ({
  container,
  bounds,
  layoutKey,
}: Readonly<{
  container: RefObject<HTMLDivElement | null>;
  bounds: Rect;
  layoutKey: string;
}>): null => {
  const flow = useReactFlow<OrchestrationNode, OrchestrationEdge>();

  useEffect(() => {
    const element = container.current;
    if (!element) {
      return;
    }

    const clipElement = element.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    let frame: number | undefined;
    let followUpFrame: number | undefined;
    let fitRequest = 0;
    let wasVisible = false;
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    const scheduleFit = (animate: boolean) => {
      const request = ++fitRequest;
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
      }
      if (followUpFrame !== undefined) {
        window.cancelAnimationFrame(followUpFrame);
      }
      frame = window.requestAnimationFrame(() => {
        followUpFrame = window.requestAnimationFrame(() => {
          const { width, height } = element.getBoundingClientRect();
          if (width <= 0 || height <= 0) {
            wasVisible = false;
            return;
          }
          const duration = animate && !reducedMotion ? 160 : 0;
          if (request === fitRequest) {
            void fitGraphToVisibleArea(flow, element, bounds, duration);
          }
          wasVisible = true;
        });
      });
    };

    const observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      if (width <= 0 || height <= 0) {
        wasVisible = false;
        return;
      }
      scheduleFit(!wasVisible);
    });

    observer.observe(element);
    if (clipElement && clipElement !== element) {
      observer.observe(clipElement);
    }
    scheduleFit(false);

    return () => {
      fitRequest += 1;
      observer.disconnect();
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
      }
      if (followUpFrame !== undefined) {
        window.cancelAnimationFrame(followUpFrame);
      }
    };
  }, [bounds, container, flow, layoutKey]);

  return null;
};

export const OrchestrationActivity = ({
  activity,
}: Readonly<{ activity: OrchestrationActivityViewModel }>) => {
  const { selectTask, selectedTask, refreshTask } =
    useOrchestrationStore();
  const graph = useMemo(
    () => layoutGraph(activity, selectTask, selectedTask?.taskId),
    [activity, selectTask, selectedTask?.taskId],
  );
  const graphContainer = useRef<HTMLDivElement>(null);
  const layoutKey = useMemo(
    () =>
      activity.tasks
        .map(
          (task) =>
            `${task.taskId}:${task.title}:${task.dependsOn.join(',')}`,
        )
        .join('|'),
    [activity.tasks],
  );
  const completedTasks = activity.tasks.filter(
    (task) => task.status === 'completed',
  ).length;
  const failedTasks = activity.tasks.filter(
    (task) => task.status === 'failed',
  ).length;
  const activeTasks = activity.tasks.filter(
    (task) =>
      task.status === 'running' || task.status === 'waitingApproval',
  ).length;
  const summaryLabel =
    failedTasks > 0
      ? `${failedTasks} failed`
      : activeTasks > 0
        ? `${activeTasks} active`
        : `${completedTasks} / ${activity.tasks.length} completed`;

  useEffect(() => {
    const current = activity.tasks.find(
      (task) => task.taskId === selectedTask?.taskId,
    );
    if (current) {
      refreshTask(current);
    }
  }, [activity.tasks, refreshTask, selectedTask?.taskId]);

  return (
    <section
      className="overflow-hidden rounded-2xl border bg-background shadow-[0_16px_50px_var(--shadow-soft)]"
      aria-label="Agent orchestration"
    >
      <header className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-surface/25 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border bg-background shadow-sm">
            <Network className="size-3.5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-medium">Live orchestration</p>
            <p className="mt-0.5 truncate font-mono text-[9px] uppercase tracking-[0.12em] text-tertiary">
              {activity.tasks.length} delegated Agent
              {activity.tasks.length === 1 ? '' : 's'} · Dependency map
            </p>
          </div>
        </div>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-[10px] text-secondary shadow-sm',
            failedTasks > 0 && 'border-destructive/30 text-destructive',
          )}
          aria-live="polite"
        >
          {failedTasks > 0 ? (
            <TriangleAlert className="size-3" aria-hidden="true" />
          ) : activeTasks > 0 ? (
            <Sparkles className="size-3" aria-hidden="true" />
          ) : (
            <Check className="size-3 text-success" aria-hidden="true" />
          )}
          {summaryLabel}
        </span>
      </header>
      <div
        ref={graphContainer}
        className="relative h-[25rem] min-h-80 bg-surface/15"
      >
        <ReactFlow<OrchestrationNode, OrchestrationEdge>
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={GRAPH_MIN_ZOOM}
          maxZoom={GRAPH_MAX_ZOOM}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          colorMode="system"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={18}
            size={0.8}
            color="var(--border)"
            className="opacity-55"
          />
          <GraphAutoFit
            container={graphContainer}
            bounds={graph.bounds}
            layoutKey={layoutKey}
          />
          <GraphControls container={graphContainer} bounds={graph.bounds} />
        </ReactFlow>
      </div>
    </section>
  );
};
