import {
  CircleHelp,
  Cpu,
  Monitor,
  Moon,
  PlugZap,
  Settings,
  Sun,
  X,
} from 'lucide-react';

import { ConnectionStatus } from '@/renderer/components/connection/connection-status';
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
import { AboutSettings } from './about-settings';
import { CommandEnvironmentSettings } from './command-environment-settings';
import { useStore } from './use-store';

const SETTINGS_SECTIONS: readonly Readonly<{
  id: SettingsSection | 'mcp';
  label: string;
  icon: typeof Monitor;
  disabled?: boolean;
  notice?: string;
}>[] = [
  { id: 'general', label: '通用', icon: Monitor },
  { id: 'model', label: '模型', icon: Cpu },
  {
    id: 'mcp',
    label: 'MCP',
    icon: PlugZap,
    disabled: true,
    notice: '即将推出',
  },
  { id: 'about', label: '关于', icon: CircleHelp },
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
  workspaceId,
  threadId,
}: Pick<
  SettingsDialogProps,
  'isDark' | 'themeLabel' | 'toggleTheme' | 'workspaceId' | 'threadId'
>) => (
  <>
    <SettingsPageHeader
      icon={Monitor}
      title="通用"
      description="设置桌面外观，并查看本地运行时状态。"
    />
    <div className="space-y-7 px-6 py-6">
      <section aria-labelledby="appearance-title">
        <h3 id="appearance-title" className="text-sm font-medium">
          配色主题
        </h3>
        <p className="mt-1 text-sm font-normal text-secondary">
          选择适合当前环境的界面主题。
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
            浅色
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
            深色
          </Button>
          <span className="sr-only">{themeLabel}</span>
        </div>
      </section>

      <section aria-labelledby="runtime-title">
        <h3 id="runtime-title" className="mb-3 text-sm font-medium">
          本地运行时
        </h3>
        <ConnectionStatus />
      </section>
      <CommandEnvironmentSettings
        workspaceId={workspaceId}
        threadId={threadId}
      />
    </div>
  </>
);

export const SettingsDialog = ({
  isDark,
  themeLabel,
  toggleTheme,
  workspaceId,
  threadId,
  open,
  onOpenChange,
}: SettingsDialogProps) => {
  const store = useStore();
  const actualOpen = open ?? store.open;

  return (
    <Dialog
      open={actualOpen}
      onOpenChange={(nextOpen) => {
        store.setOpen(nextOpen);
        onOpenChange?.(nextOpen);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start"
          aria-label="打开设置"
        >
          <Settings aria-hidden="true" />
          设置
        </Button>
      </DialogTrigger>
      <DialogContent className="h-[min(44rem,calc(100vh-2rem))] max-w-[58rem]">
        <div className="flex h-16 shrink-0 items-center border-b px-5">
          <DialogTitle className="text-base font-semibold tracking-[-0.02em]">
            设置
          </DialogTitle>
          <DialogDescription className="sr-only">
            配置 SugarCode 桌面端、模型连接、MCP 服务和应用信息。
          </DialogDescription>
          <DialogClose asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="ml-auto"
              aria-label="关闭设置"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[11.5rem_minmax(0,1fr)] sm:grid-rows-1">
          <nav
            className="border-b bg-surface/45 p-2 sm:border-r sm:border-b-0"
            aria-label="设置分类"
          >
            <div className="grid grid-cols-4 gap-1 sm:block sm:space-y-1">
              {SETTINGS_SECTIONS.map((section) => {
                const Icon = section.icon;
                const current =
                  section.id !== 'mcp' && store.section === section.id;
                return (
                  <button
                    key={section.id}
                    type="button"
                    disabled={section.disabled}
                    aria-current={current ? 'page' : undefined}
                    onClick={() => {
                      if (section.id !== 'mcp') {
                        store.setSection(section.id);
                      }
                    }}
                    className={`flex w-full min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:justify-start sm:gap-2.5 sm:px-3 sm:text-left ${
                      section.disabled
                        ? 'cursor-not-allowed border-transparent text-tertiary'
                        : current
                        ? 'border-brand/25 bg-brand/10 text-brand'
                        : 'border-transparent text-secondary hover:bg-surface-hover hover:text-foreground'
                    }`}
                  >
                    <Icon className="size-4 text-tertiary" aria-hidden="true" />
                    <span className="min-w-0 leading-5">
                      <span className="block">{section.label}</span>
                      {section.notice ? (
                        <span className="block text-[10px] leading-3 font-medium text-warning">
                          {section.notice}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>

          <section className="relative min-h-0 overflow-y-auto" aria-live="polite">
            {store.section === 'general' ? (
              <GeneralSettings
                isDark={isDark}
                themeLabel={themeLabel}
                toggleTheme={toggleTheme}
                workspaceId={workspaceId}
                threadId={threadId}
              />
            ) : null}
            {store.section === 'model' ? (
              <ModelConfigSettingsPanel active={actualOpen} />
            ) : null}
            {store.section === 'about' ? <AboutSettings /> : null}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
};
