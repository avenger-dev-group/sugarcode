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
import { useEffect, useMemo } from 'react';

import { Button } from '@/renderer/components/ui/button';

import type {
  AgentTaskRole,
  AgentTaskViewModel,
  OrchestrationActivityViewModel,
} from './types';
import { useOrchestrationStore } from './use-store';

const NODE_WIDTH = 184;
const NODE_HEIGHT = 78;
const ROOT_NODE_ID = 'main-agent';

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
  return (
    <button
      type="button"
      onClick={() => data.onSelect(task)}
      className="nodrag relative flex h-[78px] w-[184px] flex-col rounded-xl border bg-background px-3 py-2.5 text-left shadow-[0_10px_28px_var(--shadow-soft)] transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transform-none motion-reduce:transition-none"
      aria-label={`${ROLE_LABELS[task.role]} ${task.title}, ${STATUS_LABELS[task.status]}`}
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
      <span className="mt-2 line-clamp-2 w-full text-[12px] font-medium leading-4">
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
    width: NODE_WIDTH,
    height: 66,
  });

  const taskByKey = new Map(
    activity.tasks.map((task) => [task.clientTaskKey, task]),
  );
  for (const task of activity.tasks) {
    graph.setNode(task.taskId, {
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
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
        x: graph.node(ROOT_NODE_ID).x - NODE_WIDTH / 2,
        y: graph.node(ROOT_NODE_ID).y - 33,
      },
      selectable: false,
      draggable: false,
      focusable: false,
    },
    ...activity.tasks.map((task): OrchestrationNode => {
      const position = graph.node(task.taskId);
      return {
        id: task.taskId,
        type: 'orchestrationNode',
        data: { kind: 'agent', task, onSelect },
        position: {
          x: position.x - NODE_WIDTH / 2,
          y: position.y - NODE_HEIGHT / 2,
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

export const OrchestrationActivity = ({
  activity,
}: Readonly<{ activity: OrchestrationActivityViewModel }>) => {
  const { selectTask, selectedTask, refreshTask } =
    useOrchestrationStore();
  const graph = useMemo(
    () => layoutGraph(activity, selectTask),
    [activity, selectTask],
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
      <div className="h-[22rem] min-h-72 bg-surface/30">
        <ReactFlow<OrchestrationNode, OrchestrationEdge>
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
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
          <GraphControls />
        </ReactFlow>
      </div>
    </section>
  );
};
