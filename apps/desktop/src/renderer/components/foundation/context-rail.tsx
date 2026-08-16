import { useState, type ReactNode } from 'react';
import {
  BookOpenText,
  ClipboardList,
  FileCode2,
  FileDiff,
  Files,
  GitBranch,
  Globe2,
  Plus,
  X,
} from 'lucide-react';

import { AgentDetail } from '@/renderer/components/orchestration/agent-detail';
import { useOrchestrationStore } from '@/renderer/components/orchestration/use-store';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/renderer/components/ui/popover';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { SkillDocument } from '@/renderer/components/skills/skill-document';
import { PlanDocument } from '@/renderer/components/thread/plan-document';
import { closePreview, getPreviewState } from '@/renderer/services/preview';
import { PreviewWorkbench } from '@/renderer/components/workspace/preview/preview-workbench';
import { FileDiffWorkbench } from '@/renderer/components/workspace/review/file-diff-workbench';
import { WorkspaceDocument } from '@/renderer/components/workspace/review/workspace-document';
import { WorkspaceWorkbench } from '@/renderer/components/workspace/workbench/workspace-workbench';

const ContextTab = ({
  active,
  icon,
  label,
  onActivate,
  onClose,
}: Readonly<{
  active: boolean;
  icon: ReactNode;
  label: string;
  onActivate: () => void;
  onClose: () => void;
}>) => (
  <div
    className={`group flex h-8 min-w-28 max-w-52 shrink-0 items-center rounded-lg transition-colors ${
      active
        ? 'bg-background text-foreground shadow-[0_1px_3px_var(--shadow-soft)]'
        : 'text-secondary hover:bg-background/70 hover:text-foreground'
    }`}
  >
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 pr-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      title={label}
      onClick={onActivate}
    >
      <span className="shrink-0" aria-hidden="true">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
    <button
      type="button"
      aria-label={`关闭 ${label}`}
      className="mr-1 grid size-5 shrink-0 place-items-center rounded-md text-tertiary opacity-70 transition hover:bg-surface-hover hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClose}
    >
      <X className="size-3" aria-hidden="true" />
    </button>
  </div>
);

const WorkspaceMenu = ({
  onOpenFiles,
  onOpenBrowser,
  onSelected,
  compact = false,
}: Readonly<{
  onOpenFiles: () => void;
  onOpenBrowser: () => void;
  onSelected?: () => void;
  compact?: boolean;
}>) => {
  const choices = [
    { icon: <Files className="size-4" />, label: '文件', hint: '项目文件', action: onOpenFiles },
    { icon: <Globe2 className="size-4" />, label: '浏览器', hint: '新标签页', action: onOpenBrowser },
  ];
  return (
    <div className={compact ? 'p-1.5' : 'w-full max-w-sm space-y-1'}>
      {choices.map((choice) => (
        <button
          key={choice.label}
          type="button"
          className={`group flex w-full items-center text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
            compact
              ? 'h-9 gap-2.5 rounded-lg px-2.5 hover:bg-surface'
              : 'h-11 gap-3 rounded-xl px-3 hover:bg-surface'
          }`}
          onClick={() => {
            choice.action();
            onSelected?.();
          }}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-lg border bg-background text-secondary shadow-sm transition group-hover:text-foreground">
            {choice.icon}
          </span>
          <span className="min-w-0 flex-1 text-sm font-medium">{choice.label}</span>
          <span className="text-[11px] text-tertiary">{choice.hint}</span>
        </button>
      ))}
    </div>
  );
};

export const ContextRail = () => {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const {
    activeTab,
    browserTabs,
    closeAgentTab,
    closeFilesTab,
    closePlanTab,
    closePreviewTab,
    closeResourceTab,
    filesTabOpen,
    openFiles,
    openPreview,
    requestedFile,
    selectedPlan,
    selectedResource,
    selectedTask,
    setActiveTab,
    setPreviewTitle,
  } = useOrchestrationStore();
  const hasTabs =
    filesTabOpen ||
    browserTabs.length > 0 ||
    selectedResource !== null ||
    selectedPlan !== null ||
    selectedTask !== null;
  const resourceTitle = selectedResource
    ? selectedResource.kind === 'skill'
      ? `${selectedResource.name} Skill`
      : selectedResource.path
    : '';
  const resourceLabel = selectedResource
    ? selectedResource.kind === 'skill'
      ? `${selectedResource.name} Skill`
      : selectedResource.path.split('/').at(-1) ?? selectedResource.path
    : '';

  const handleCloseBrowser = (id: string): void => {
    closePreviewTab(id);
    void getPreviewState()
      .then((snapshot) => snapshot.tabs.find((tab) => tab.previewId === id))
      .then((tab) => {
        if (tab?.status === 'opening' || tab?.status === 'ready') {
          return closePreview({
            generation: tab.generation,
            sessionId: tab.sessionId,
          });
        }
        return undefined;
      })
      .catch((): undefined => undefined);
  };

  if (!hasTabs) {
    return (
      <section className="relative grid h-full min-h-0 place-items-center overflow-hidden bg-background px-8" aria-label="右侧工作区">
        <div className="pointer-events-none absolute inset-x-10 top-1/2 h-56 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,var(--surface-hover),transparent_70%)] opacity-55" />
        <div className="relative w-full max-w-sm">
          <p className="mb-4 px-3 text-[11px] font-medium uppercase tracking-[0.16em] text-tertiary">打开到右侧</p>
          <WorkspaceMenu
            onOpenFiles={openFiles}
            onOpenBrowser={() => openPreview()}
          />
        </div>
      </section>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="window-context-titlebar window-drag-region flex h-11 shrink-0 items-center border-b bg-surface/65 px-2">
        <div className="window-no-drag flex h-9 min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="右侧工作区标签">
          {filesTabOpen ? (
            <ContextTab
              active={activeTab === 'files'}
              icon={<Files className="size-3.5" />}
              label="文件"
              onActivate={() => setActiveTab('files')}
              onClose={closeFilesTab}
            />
          ) : null}
          {browserTabs.map((tab) => (
            <ContextTab
              key={tab.id}
              active={activeTab === `browser:${tab.id}`}
              icon={<Globe2 className="size-3.5" />}
              label={tab.title}
              onActivate={() => setActiveTab(`browser:${tab.id}`)}
              onClose={() => handleCloseBrowser(tab.id)}
            />
          ))}
          {selectedResource ? (
            <ContextTab
              active={activeTab === 'resource'}
              icon={
                selectedResource.kind === 'skill' ? (
                  <BookOpenText className="size-3.5" />
                ) : selectedResource.kind === 'diff' ? (
                  <FileDiff className="size-3.5" />
                ) : (
                  <FileCode2 className="size-3.5" />
                )
              }
              label={resourceLabel}
              onActivate={() => setActiveTab('resource')}
              onClose={closeResourceTab}
            />
          ) : null}
          {selectedPlan ? (
            <ContextTab
              active={activeTab === 'plan'}
              icon={<ClipboardList className="size-3.5" />}
              label="计划"
              onActivate={() => setActiveTab('plan')}
              onClose={closePlanTab}
            />
          ) : null}
          {selectedTask ? (
            <ContextTab
              active={activeTab === 'agent'}
              icon={<GitBranch className="size-3.5" />}
              label="Agent"
              onActivate={() => setActiveTab('agent')}
              onClose={closeAgentTab}
            />
          ) : null}
          <Popover open={addMenuOpen} onOpenChange={setAddMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="打开新的右侧标签"
                className="grid size-8 shrink-0 place-items-center rounded-lg text-tertiary transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus className="size-4" aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={5} className="w-60 p-0">
              <WorkspaceMenu
                compact
                onOpenFiles={openFiles}
                onOpenBrowser={() => openPreview()}
                onSelected={() => setAddMenuOpen(false)}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {filesTabOpen ? (
        <div className={`${activeTab === 'files' ? 'block' : 'hidden'} min-h-0 flex-1`} aria-hidden={activeTab !== 'files'}>
          <WorkspaceWorkbench
            requestedPath={requestedFile?.path}
            requestKey={requestedFile?.id}
          />
        </div>
      ) : null}
      {browserTabs.map((tab) => {
        const active = activeTab === `browser:${tab.id}`;
        return (
          <div key={tab.id} className={`${active ? 'block' : 'hidden'} min-h-0 flex-1`} aria-hidden={!active}>
            <PreviewWorkbench
              active={active}
              previewId={tab.id}
              onTitleChange={(title) => setPreviewTitle(tab.id, title)}
            />
          </div>
        );
      })}
      {selectedResource ? (
        <div className={`${activeTab === 'resource' ? 'block' : 'hidden'} min-h-0 flex-1`} aria-hidden={activeTab !== 'resource'} title={resourceTitle}>
          {selectedResource.kind === 'skill' ? (
            <SkillDocument name={selectedResource.name} description={selectedResource.description} content={selectedResource.content} />
          ) : selectedResource.kind === 'diff' ? (
            <FileDiffWorkbench path={selectedResource.path} changes={selectedResource.changes} />
          ) : (
            <WorkspaceDocument path={selectedResource.path} />
          )}
        </div>
      ) : null}
      {selectedPlan ? (
        <div className={`${activeTab === 'plan' ? 'block' : 'hidden'} min-h-0 min-w-0 max-w-full flex-1 overflow-hidden`} aria-hidden={activeTab !== 'plan'}>
          <PlanDocument plan={selectedPlan} />
        </div>
      ) : null}
      {selectedTask ? (
        <ScrollArea className={`${activeTab === 'agent' ? 'block' : 'hidden'} min-h-0 flex-1`} viewportProps={{ 'aria-label': `Agent details: ${selectedTask.title}`, tabIndex: 0 }}>
          <AgentDetail task={selectedTask} />
        </ScrollArea>
      ) : null}
    </div>
  );
};
