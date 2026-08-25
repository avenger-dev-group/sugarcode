import {
  Check,
  CircleOff,
  LoaderCircle,
  Network,
  Power,
  ServerCog,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';

import type { McpSessionPanelProps } from './types';
import { useStore } from './use-store';
import { McpServerManagementWorkbench } from './server-management-workbench';

const McpSessionPanelContent = ({
  turnBusy,
  embedded = false,
}: McpSessionPanelProps) => {
  const store = useStore();
  const { session } = store;
  const applying = ['loading', 'enabling', 'disabling', 'rollingBack'].includes(
    session.status,
  );
  const connected = session.activeServerIds.length > 0;
  const selectionChanged =
    JSON.stringify(session.selectedServerIds) !==
    JSON.stringify(session.activeServerIds);

  return (
    <section
      className={
        embedded
          ? 'space-y-5 bg-background px-5 py-5 sm:px-6 sm:py-6'
          : 'space-y-4 border-t bg-background/70 px-3 py-3'
      }
      aria-label="MCP 连接"
    >
      <section aria-labelledby="mcp-server-selection-title">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h3 id="mcp-server-selection-title" className="text-sm font-medium">
              选择本次连接使用的服务
            </h3>
            <p className="mt-1 text-xs leading-5 text-secondary">
              本地 HTTP 每次只能启用 1 个；本地命令服务最多可同时启用 2 个。
            </p>
          </div>
          <span className="shrink-0 text-xs text-tertiary">
            已选 {session.selectedServerIds.length} 个
          </span>
        </div>

        {session.servers.length === 0 ? (
          <div className="mt-3 flex flex-col items-center rounded-2xl border border-dashed px-5 py-8 text-center">
            <div className="flex size-11 items-center justify-center rounded-xl bg-surface text-tertiary">
              <ServerCog className="size-5" aria-hidden="true" />
            </div>
            <p className="mt-3 text-sm font-medium">先添加一个 MCP 服务</p>
            <p className="mt-1 max-w-sm text-xs leading-5 text-secondary">
              Figma Desktop 支持一键配置，也可以添加其他本地命令或 HTTP 服务。
            </p>
          </div>
        ) : (
          <div className="mt-3 grid gap-2" aria-label="已配置的 MCP 服务">
            {session.servers.map((server) => {
              const selected = session.selectedServerIds.includes(server.id);
              const active = session.activeServerIds.includes(server.id);
              const TransportIcon = server.transport === 'stdio' ? TerminalSquare : Network;
              return (
                <button
                  type="button"
                  key={server.id}
                  aria-pressed={selected}
                  disabled={store.sessionBusy || turnBusy}
                  onClick={() => void store.toggleServer(server.id)}
                  className={`group flex w-full min-w-0 items-center gap-3 rounded-xl border p-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? 'border-brand/35 bg-brand/5 shadow-sm'
                      : 'bg-surface/50 hover:border-brand/20 hover:bg-surface'
                  }`}
                >
                  <span
                    className={`flex size-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                      selected ? 'border-brand/25 bg-brand/10 text-brand' : 'bg-background text-tertiary'
                    }`}
                  >
                    <TransportIcon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs font-medium text-foreground">
                      {server.id}
                    </span>
                    <span className="mt-1 block text-[11px] text-secondary">
                      {server.transport === 'stdio' ? '本地命令进程' : '本地 HTTP 服务'}
                    </span>
                  </span>
                  {active ? (
                    <span className="rounded-full bg-success/10 px-2 py-1 text-[10px] font-medium text-success">使用中</span>
                  ) : selected ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-brand text-brand-foreground">
                      <Check className="size-3" aria-hidden="true" />
                    </span>
                  ) : (
                    <span className="size-5 rounded-full border bg-background transition-colors group-hover:border-brand/30" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <div className="flex flex-col-reverse gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <McpServerManagementWorkbench
          sessionDisabled={session.status === 'disabled' && session.activeServerIds.length === 0}
          turnBusy={turnBusy}
        />
        <div className="flex gap-2 sm:justify-end">
          {connected ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={store.sessionBusy || turnBusy}
              onClick={() => void store.disable()}
            >
              <CircleOff aria-hidden="true" />
              停用连接
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={
              store.sessionBusy ||
              turnBusy ||
              session.selectedServerIds.length === 0 ||
              (!selectionChanged && connected) ||
              session.status === 'unavailable'
            }
            onClick={() => void store.enable()}
          >
            {applying ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <Power aria-hidden="true" />
            )}
            {connected ? '应用所选服务' : '启用连接'}
          </Button>
        </div>
      </div>

      <div className="flex gap-2.5 rounded-xl border border-brand/15 bg-brand/5 px-3.5 py-3 text-xs leading-5 text-secondary">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
        <p>服务配置会保存在本机；服务选择仅对当前 SugarCode 进程生效，所有工具调用仍需逐次授权。</p>
      </div>

      {session.actionNotice || store.actionError ? (
        <p className="rounded-xl border border-destructive/25 bg-destructive/5 px-3.5 py-2.5 text-xs leading-5 text-destructive" role="alert">
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
