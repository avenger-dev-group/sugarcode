import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { ConnectionStatus } from '@/renderer/components/connection/connection-status';
import { Button } from '@/renderer/components/ui/button';
import { GitWorkbench } from '@/renderer/components/workspace/git/git-workbench';
import { PreviewWorkbench } from '@/renderer/components/workspace/preview/preview-workbench';
import { TerminalWorkbench } from '@/renderer/components/workspace/terminal/terminal-workbench';
import { WorkspaceWorkbench } from '@/renderer/components/workspace/workbench/workspace-workbench';

type ContextRailProps = Readonly<{
  onClose: () => void;
}>;

const RailAction = ({
  label,
  children,
}: Readonly<{
  label: string;
  children: ReactNode;
}>) => (
  <div
    className="rounded-lg px-1 py-0.5 transition-colors hover:bg-surface [&>button]:h-8 [&>button]:w-full [&>button]:max-w-none [&>button]:justify-start [&>button]:border-0 [&>button]:bg-transparent [&>button]:px-2 [&>button]:shadow-none"
    aria-label={label}
  >
    {children}
  </div>
);

export const ContextRail = ({ onClose }: ContextRailProps) => (
  <div className="flex min-h-full flex-col">
    <div className="flex h-14 shrink-0 items-center border-b px-4">
      <div>
        <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-tertiary">
          Project context
        </p>
        <h2 className="mt-0.5 text-sm font-medium">Workspace</h2>
      </div>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="ml-auto xl:hidden"
        onClick={onClose}
        aria-label="Close workspace tools"
      >
        <X aria-hidden="true" />
      </Button>
    </div>

    <div className="border-b p-3">
      <ConnectionStatus />
    </div>

    <section className="px-2 py-3" aria-labelledby="workspace-actions-title">
      <p
        id="workspace-actions-title"
        className="px-2 pb-2 font-mono text-[9px] uppercase tracking-[0.16em] text-tertiary"
      >
        Tools
      </p>
      <div className="space-y-1">
        <RailAction label="Workspace explorer">
          <WorkspaceWorkbench />
        </RailAction>
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

    <p className="mt-auto border-t px-4 py-3 text-[11px] leading-4 text-tertiary">
      Files, Git, preview, and terminal remain local to the selected workspace.
    </p>
  </div>
);
