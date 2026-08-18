import {
  CircleOff,
  LoaderCircle,
  Network,
  PlugZap,
  TerminalSquare,
} from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';

import type { McpSessionPanelProps } from './types';
import { useStore } from './use-store';
import { McpServerManagementWorkbench } from './server-management-workbench';

const STATUS_LABELS = {
  loading: 'Reading configuration',
  disabled: 'Disabled for this session',
  enabling: 'Starting selected servers',
  enabled: 'Enabled for this session',
  disabling: 'Stopping MCP session',
  rollingBack: 'Restoring previous session',
  unavailable: 'Unavailable',
} as const;

const McpSessionPanelContent = ({
  turnBusy,
  embedded = false,
}: McpSessionPanelProps) => {
  const store = useStore();
  const { session } = store;
  const applying = ['loading', 'enabling', 'disabling', 'rollingBack'].includes(
    session.status,
  );
  const selectionChanged =
    JSON.stringify(session.selectedServerIds) !==
    JSON.stringify(session.activeServerIds);

  return (
    <section
      className={
        embedded
          ? 'bg-background px-3 py-5'
          : 'border-t bg-background/70 px-3 py-3'
      }
      aria-labelledby="mcp-session-title"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-tertiary">
            Local tool gate
          </p>
          <h2
            id="mcp-session-title"
            className="mt-1 flex items-center gap-2 text-sm font-medium"
          >
            <PlugZap className="size-4 text-tertiary" aria-hidden="true" />
            MCP session
          </h2>
        </div>
        <span
          className="shrink-0 rounded-full border bg-surface px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-secondary"
          role="status"
        >
          {STATUS_LABELS[session.status]}
        </span>
      </div>

      {session.servers.length === 0 ? (
        <div className="mt-3 flex gap-2 rounded-lg border border-dashed p-3 text-xs leading-5 text-secondary">
          <CircleOff className="mt-0.5 size-4 shrink-0 text-tertiary" aria-hidden="true" />
          <span>No configured MCP servers are available.</span>
        </div>
      ) : (
        <div className="mt-3 space-y-1.5" aria-label="Configured MCP servers">
          {session.servers.map((server) => {
            const selected = session.selectedServerIds.includes(server.id);
            const active = session.activeServerIds.includes(server.id);
            const TransportIcon =
              server.transport === 'stdio' ? TerminalSquare : Network;
            return (
              <button
                type="button"
                key={server.id}
                aria-pressed={selected}
                disabled={store.sessionBusy || turnBusy}
                onClick={() => void store.toggleServer(server.id)}
                className={`flex w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 ${
                  selected
                    ? 'border-brand/30 bg-brand/10 text-brand'
                    : 'border-border bg-surface text-secondary hover:text-foreground'
                }`}
              >
                <TransportIcon className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
                <span className="min-w-0 flex-1 break-all font-mono text-[10px] leading-4">
                  {server.id}
                </span>
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-tertiary">
                  {active ? 'active' : server.transport === 'stdio' ? 'stdio' : 'http'}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <McpServerManagementWorkbench
          sessionDisabled={
            session.status === 'disabled' &&
            session.activeServerIds.length === 0
          }
          turnBusy={turnBusy}
        />
        {session.activeServerIds.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={store.sessionBusy || turnBusy}
            onClick={() => void store.disable()}
          >
            Disable
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          className="flex-1"
          disabled={
            store.sessionBusy ||
            turnBusy ||
            session.selectedServerIds.length === 0 ||
            (!selectionChanged && session.activeServerIds.length > 0) ||
            session.status === 'unavailable'
          }
          onClick={() => void store.enable()}
        >
          {applying ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : null}
          {session.activeServerIds.length > 0 ? 'Apply selection' : 'Enable'}
        </Button>
      </div>

      <p className="mt-2 text-[11px] leading-4 text-secondary">
        Selection is process-local. Every tool call still requires approval.
      </p>
      {session.actionNotice || store.actionError ? (
        <p className="mt-2 text-xs leading-4 text-destructive" role="alert">
          {store.actionError ?? session.actionNotice}
        </p>
      ) : null}
    </section>
  );
};

export const McpSessionPanel = (props: McpSessionPanelProps) =>
  typeof window.sugarcode?.getMcpSessionState === 'function' ? (
    <McpSessionPanelContent {...props} />
  ) : null;
