import {
  Cpu,
  Monitor,
  Moon,
  PlugZap,
  Settings,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';

import { ConnectionStatus } from '@/renderer/components/connection/connection-status';
import { McpSessionPanel } from '@/renderer/components/mcp/session-panel';
import { ModelConfigSettingsPanel } from '@/renderer/components/model-config/model-config-workbench';
import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/renderer/components/ui/dialog';

import type {
  SettingsDialogProps,
  SettingsSection,
} from './types';
import { useStore } from './use-store';

const SETTINGS_SECTIONS: readonly Readonly<{
  id: SettingsSection;
  label: string;
  icon: typeof Monitor;
}>[] = [
  { id: 'general', label: 'General', icon: Monitor },
  { id: 'model', label: 'Model', icon: Cpu },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mcp', label: 'MCP', icon: PlugZap },
];

const SettingsPageHeader = ({
  icon: Icon,
  title,
  description,
}: Readonly<{
  icon: typeof Monitor;
  title: string;
  description: string;
}>) => (
  <header className="border-b px-6 py-5">
    <div className="flex items-center gap-2.5">
      <Icon className="size-4 text-secondary" aria-hidden="true" />
      <h2 className="text-sm font-medium">{title}</h2>
    </div>
    <p className="mt-1.5 max-w-2xl text-sm font-normal leading-normal text-secondary">
      {description}
    </p>
  </header>
);

const GeneralSettings = ({
  isDark,
  themeLabel,
  toggleTheme,
}: Pick<
  SettingsDialogProps,
  'isDark' | 'themeLabel' | 'toggleTheme'
>) => (
  <>
    <SettingsPageHeader
      icon={Monitor}
      title="General"
      description="Choose the desktop appearance and inspect the packaged local runtime."
    />
    <div className="space-y-7 px-6 py-6">
      <section aria-labelledby="appearance-title">
        <h3 id="appearance-title" className="text-sm font-medium">
          Color theme
        </h3>
        <p className="mt-1 text-sm font-normal text-secondary">
          Keep the workbench comfortable in your current environment.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            variant={isDark ? 'outline' : 'default'}
            aria-pressed={!isDark}
            onClick={() => {
              if (isDark) {
                toggleTheme();
              }
            }}
          >
            <Sun aria-hidden="true" />
            Light
          </Button>
          <Button
            type="button"
            variant={isDark ? 'default' : 'outline'}
            aria-pressed={isDark}
            onClick={() => {
              if (!isDark) {
                toggleTheme();
              }
            }}
          >
            <Moon aria-hidden="true" />
            Dark
          </Button>
          <span className="sr-only">{themeLabel}</span>
        </div>
      </section>

      <section aria-labelledby="runtime-title">
        <h3 id="runtime-title" className="mb-3 text-sm font-medium">
          Local runtime
        </h3>
        <ConnectionStatus />
      </section>
    </div>
  </>
);

const SkillsSettings = () => (
  <>
    <SettingsPageHeader
      icon={Sparkles}
      title="Skills"
      description="Workspace Skills customize a Turn without changing SugarCode's authority or safety boundaries."
    />
    <div className="px-6 py-6">
      <div className="rounded-xl border bg-surface p-5">
        <div className="flex items-start gap-3">
          <span className="rounded-lg border bg-background p-2 text-secondary">
            <Sparkles className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-medium">
              Discovered from the active workspace
            </h3>
            <p className="mt-1.5 text-sm font-normal leading-[22px] text-secondary">
              SugarCode loads bounded Skill definitions from the workspace when
              the local Agent starts. Mention a Skill by name in your request
              to select it for that Turn.
            </p>
          </div>
        </div>
        <div className="mt-4 rounded-lg border bg-background px-3 py-2.5">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-tertiary">
            Workspace location
          </p>
          <p className="mt-1 break-all font-mono text-xs text-secondary">
            .agents/skills/&lt;name&gt;/SKILL.md
          </p>
        </div>
      </div>
      <p className="mt-4 text-xs leading-5 text-tertiary">
        Skill inventory is read-only in Desktop. Add or edit Skill files in the
        workspace, then restart the local Agent to refresh discovery.
      </p>
    </div>
  </>
);

export const SettingsDialog = ({
  isDark,
  themeLabel,
  turnBusy,
  toggleTheme,
}: SettingsDialogProps) => {
  const store = useStore();

  return (
    <Dialog open={store.open} onOpenChange={store.setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start"
          aria-label="Open settings"
        >
          <Settings aria-hidden="true" />
          Settings
        </Button>
      </DialogTrigger>
      <DialogContent className="h-[min(44rem,calc(100vh-2rem))] max-w-[58rem]">
        <div className="flex h-16 shrink-0 items-center border-b px-5">
          <DialogTitle className="text-base font-semibold tracking-[-0.02em]">
            Settings
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure SugarCode Desktop, the model connection, workspace
            Skills, and MCP servers.
          </DialogDescription>
          <DialogClose asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="ml-auto"
              aria-label="Close settings"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[11.5rem_minmax(0,1fr)] sm:grid-rows-1">
          <nav
            className="border-b bg-surface/45 p-2 sm:border-r sm:border-b-0"
            aria-label="Settings sections"
          >
            <div className="grid grid-cols-4 gap-1 sm:block sm:space-y-1">
              {SETTINGS_SECTIONS.map((section) => {
                const Icon = section.icon;
                const current = store.section === section.id;
                return (
                  <button
                    key={section.id}
                    type="button"
                    aria-current={current ? 'page' : undefined}
                    onClick={() => store.setSection(section.id)}
                    className={`flex w-full min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:justify-start sm:gap-2.5 sm:px-3 sm:text-left ${
                      current
                        ? 'border-border bg-background text-foreground shadow-sm'
                        : 'border-transparent text-secondary hover:bg-surface-hover hover:text-foreground'
                    }`}
                  >
                    <Icon className="size-4 text-tertiary" aria-hidden="true" />
                    {section.label}
                  </button>
                );
              })}
            </div>
          </nav>

          <section className="min-h-0 overflow-y-auto" aria-live="polite">
            {store.section === 'general' ? (
              <GeneralSettings
                isDark={isDark}
                themeLabel={themeLabel}
                toggleTheme={toggleTheme}
              />
            ) : null}
            {store.section === 'model' ? (
              <>
                <SettingsPageHeader
                  icon={Cpu}
                  title="Model"
                  description="Configure the single OpenAI-compatible model connection used by the packaged local Agent."
                />
                <div className="px-6 py-6">
                  <ModelConfigSettingsPanel active={store.open} />
                </div>
              </>
            ) : null}
            {store.section === 'skills' ? <SkillsSettings /> : null}
            {store.section === 'mcp' ? (
              <>
                <SettingsPageHeader
                  icon={PlugZap}
                  title="MCP"
                  description="Choose the bounded local servers available to this process and manage the saved registry."
                />
                <div className="px-3 pb-5">
                  <McpSessionPanel turnBusy={turnBusy} embedded />
                </div>
              </>
            ) : null}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
};
