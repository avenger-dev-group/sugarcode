import type { ReactNode } from 'react';
import {
  BookOpenText,
  FileCode2,
  FileDiff,
  FolderTree,
  GitBranch,
  X,
} from 'lucide-react';

import { AgentDetail } from '@/renderer/components/orchestration/agent-detail';
import { useOrchestrationStore } from '@/renderer/components/orchestration/use-store';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { SkillDocument } from '@/renderer/components/skills/skill-document';
import { GitWorkbench } from '@/renderer/components/workspace/git/git-workbench';
import { PreviewWorkbench } from '@/renderer/components/workspace/preview/preview-workbench';
import { TerminalWorkbench } from '@/renderer/components/workspace/terminal/terminal-workbench';
import { WorkspaceWorkbench } from '@/renderer/components/workspace/workbench/workspace-workbench';
import { FileDiffWorkbench } from '@/renderer/components/workspace/review/file-diff-workbench';
import { WorkspaceDocument } from '@/renderer/components/workspace/review/workspace-document';

const RailAction = ({
  label,
  children,
}: Readonly<{
  label: string;
  children: ReactNode;
}>) => (
  <div
    className="min-w-0 flex-1 rounded-lg px-0.5 transition-colors hover:bg-surface [&>button]:h-8 [&>button]:w-full [&>button]:max-w-none [&>button]:justify-center [&>button]:border-0 [&>button]:bg-transparent [&>button]:px-1.5 [&>button]:shadow-none"
    aria-label={label}
  >
    {children}
  </div>
);

export const ContextRail = () => {
  const {
    activeTab,
    closeAgentTab,
    closeResourceTab,
    openFile,
    selectedResource,
    selectedTask,
    setActiveTab,
  } = useOrchestrationStore();
  const workspaceActive = activeTab === 'workspace';
  const resourceTitle = selectedResource
    ? selectedResource.kind === 'skill'
      ? `${selectedResource.name} Skill`
      : selectedResource.path
    : '';
  const resourceLabel = selectedResource
    ? selectedResource.kind === 'skill'
      ? `${selectedResource.name} Skill`
      : selectedResource.path.split('/').at(-1)
    : '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="window-drag-region flex h-11 shrink-0 items-center border-b px-3">
        <div
          className="window-no-drag flex h-8 min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
          role="tablist"
          aria-label="Context rail"
        >
          <button
            type="button"
            role="tab"
            aria-selected={workspaceActive}
            className={`flex h-8 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              workspaceActive
                ? 'border-link text-link'
                : 'border-transparent text-secondary hover:bg-surface hover:text-foreground'
            }`}
            onClick={() => setActiveTab('workspace')}
          >
            <FolderTree className="size-3.5" aria-hidden="true" />
            项目
          </button>
          {selectedResource ? (
            <div
              className={`flex h-8 min-w-28 max-w-56 shrink-0 items-center border-b-2 transition-colors ${
                activeTab === 'resource'
                  ? 'border-link text-link'
                  : 'border-transparent text-secondary hover:bg-surface hover:text-foreground'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'resource'}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 pr-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={resourceTitle}
                onClick={() => setActiveTab('resource')}
              >
                {selectedResource.kind === 'skill' ? (
                  <BookOpenText
                    className="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                ) : selectedResource.kind === 'diff' ? (
                  <FileDiff className="size-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <FileCode2 className="size-3.5 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate">{resourceLabel}</span>
              </button>
              <button
                type="button"
                aria-label={`关闭 ${resourceTitle}`}
                className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-tertiary hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={closeResourceTab}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {selectedTask ? (
            <div
              className={`flex h-8 min-w-24 max-w-48 shrink-0 items-center border-b-2 transition-colors ${
                activeTab === 'agent'
                  ? 'border-link text-link'
                  : 'border-transparent text-secondary hover:bg-surface hover:text-foreground'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'agent'}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 pr-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setActiveTab('agent')}
              >
                <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">Agent</span>
              </button>
              <button
                type="button"
                aria-label="关闭 Agent 标签页"
                title={`关闭 Agent 标签页：${selectedTask.title}`}
                className="mr-1 flex size-5 items-center justify-center rounded text-tertiary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={closeAgentTab}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div
        className={`${workspaceActive ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`}
        aria-hidden={!workspaceActive}
      >
          <div className="min-h-0 flex-1">
            <WorkspaceWorkbench
              activePath={
                selectedResource && selectedResource.kind !== 'skill'
                  ? selectedResource.path
                  : undefined
              }
              onOpenFile={openFile}
            />
          </div>
          <section className="shrink-0 border-t p-2" aria-label="项目工具">
            <div className="flex gap-1">
              <RailAction label="Git changes">
                <GitWorkbench />
              </RailAction>
              <RailAction label="Local preview">
                <PreviewWorkbench />
              </RailAction>
              <RailAction label="Local terminal">
                <TerminalWorkbench />
              </RailAction>
            </div>
          </section>
      </div>
      {selectedResource ? (
        <div
          className={`${activeTab === 'resource' ? 'block' : 'hidden'} min-h-0 flex-1`}
          aria-hidden={activeTab !== 'resource'}
        >
          {selectedResource.kind === 'skill' ? (
            <SkillDocument
              name={selectedResource.name}
              description={selectedResource.description}
              content={selectedResource.content}
            />
          ) : selectedResource.kind === 'diff' ? (
            <FileDiffWorkbench
              path={selectedResource.path}
              changes={selectedResource.changes}
            />
          ) : (
            <WorkspaceDocument path={selectedResource.path} />
          )}
        </div>
      ) : null}
      {selectedTask ? (
        <ScrollArea
          className={`${activeTab === 'agent' ? 'block' : 'hidden'} min-h-0 flex-1`}
          viewportProps={{
            'aria-label': `Agent details: ${selectedTask.title}`,
            tabIndex: 0,
          }}
        >
          <AgentDetail task={selectedTask} />
        </ScrollArea>
      ) : null}
    </div>
  );
};
