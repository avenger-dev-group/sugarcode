import { graphlib, layout as dagreLayout } from '@dagrejs/dagre';
import {
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
} from '@xyflow/react';
import {
  Binoculars,
  Check,
  Circle,
  FilePenLine,
  Focus,
  Minus,
  Plus,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useRef, type RefObject } from 'react';

import { Button } from '@/renderer/components/ui/button';

import type {
  AgentTaskRole,
  AgentTaskViewModel,
  OrchestrationActivityViewModel,
} from './types';
import { useOrchestrationStore } from './use-store';

const ROOT_NODE_WIDTH = 168;
const ROOT_NODE_HEIGHT = 66;
const AGENT_NODE_WIDTH = 184;
const AGENT_NODE_TITLE_WIDTH = 158;
const AGENT_NODE_CHROME_HEIGHT = 52;
const AGENT_NODE_TITLE_LINE_HEIGHT = 16;
const ROOT_NODE_ID = 'main-agent';

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
}: NodeProps<OrchestrationNode>) => {
  if (data.kind === 'root') {
    return (
      <div className="flex h-[66px] w-[168px] items-center gap-3 rounded-xl border border-primary/20 bg-background px-3 shadow-[0_10px_30px_var(--shadow-soft)]">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="size-4" aria-hidden="true" />
        </span>
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-tertiary">
            Orchestrator
          </p>
          <p className="mt-0.5 text-[13px] font-medium">Main Agent</p>
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
  return (
    <button
      type="button"
      onClick={() => data.onSelect(task)}
      className="nodrag pointer-events-auto relative flex w-[184px] cursor-pointer flex-col rounded-xl border bg-background px-3 py-2.5 text-left shadow-[0_10px_28px_var(--shadow-soft)] transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transform-none motion-reduce:transition-none"
      style={{ height }}
      aria-label={`${ROLE_LABELS[task.role]} ${task.title}, ${STATUS_LABELS[task.status]}`}
      title={task.title}
      data-agent-status={task.status}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!size-1.5 !border-0 !bg-primary/40"
      />
      <div className="flex w-full min-w-0 items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface [&>svg]:size-3.5">
          <RoleIcon role={task.role} />
        </span>
        <span className="truncate font-mono text-[9px] uppercase tracking-[0.14em] text-tertiary">
          {ROLE_LABELS[task.role]}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[9px] text-secondary [&>svg]:size-2.5">
          <StatusIcon status={task.status} />
          {STATUS_LABELS[task.status]}
        </span>
      </div>
      <span className="mt-2 w-full break-words text-[12px] font-medium leading-4">
        {task.title}
      </span>
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
): Readonly<{
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
}> => {
  const graph = new graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: 'TB',
    ranksep: 44,
    nodesep: 28,
    marginx: 16,
    marginy: 16,
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
        selectable: false,
        draggable: false,
        focusable: true,
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
  return { nodes, edges };
};

const GraphControls = () => {
  const flow = useReactFlow<OrchestrationNode, OrchestrationEdge>();
  return (
    <Panel position="top-right" className="!m-2 flex gap-1">
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="size-7 bg-background/90"
        onClick={() => void flow.zoomIn({ duration: 120 })}
        aria-label="Zoom orchestration in"
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="size-7 bg-background/90"
        onClick={() => void flow.zoomOut({ duration: 120 })}
        aria-label="Zoom orchestration out"
      >
        <Minus className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="size-7 bg-background/90"
        onClick={() => void flow.fitView({ padding: 0.2, duration: 160 })}
        aria-label="Fit orchestration to view"
      >
        <Focus className="size-3.5" aria-hidden="true" />
      </Button>
    </Panel>
  );
};

const GraphAutoFit = ({
  container,
  layoutKey,
}: Readonly<{
  container: RefObject<HTMLDivElement | null>;
  layoutKey: string;
}>): null => {
  const flow = useReactFlow<OrchestrationNode, OrchestrationEdge>();

  useEffect(() => {
    const element = container.current;
    if (!element) {
      return;
    }

    let frame: number | undefined;
    let followUpFrame: number | undefined;
    let wasVisible = false;
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    const scheduleFit = (animate: boolean) => {
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
          void flow.fitView({
            padding: 0.2,
            duration: animate && !reducedMotion ? 160 : 0,
          });
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
    scheduleFit(false);

    return () => {
      observer.disconnect();
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
      }
      if (followUpFrame !== undefined) {
        window.cancelAnimationFrame(followUpFrame);
      }
    };
  }, [container, flow, layoutKey]);

  return null;
};

export const OrchestrationActivity = ({
  activity,
}: Readonly<{ activity: OrchestrationActivityViewModel }>) => {
  const { selectTask, selectedTask, refreshTask } =
    useOrchestrationStore();
  const graph = useMemo(
    () => layoutGraph(activity, selectTask),
    [activity, selectTask],
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
      className="overflow-hidden rounded-2xl border bg-background/80 shadow-[0_16px_50px_var(--shadow-soft)]"
      aria-label="Agent orchestration"
    >
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg bg-surface">
          <Sparkles className="size-3.5" aria-hidden="true" />
        </span>
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-tertiary">
            Live orchestration
          </p>
          <p className="mt-0.5 text-[13px] font-medium">
            {activity.tasks.length} delegated Agent
            {activity.tasks.length === 1 ? '' : 's'}
          </p>
        </div>
      </header>
      <div
        ref={graphContainer}
        className="h-[25rem] min-h-80 bg-surface/30"
      >
        <ReactFlow<OrchestrationNode, OrchestrationEdge>
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={0.45}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          colorMode="system"
        >
          <GraphAutoFit
            container={graphContainer}
            layoutKey={layoutKey}
          />
          <GraphControls />
        </ReactFlow>
      </div>
    </section>
  );
};
