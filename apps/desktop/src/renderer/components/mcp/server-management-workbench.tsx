import {
  AppWindowMac,
  BadgeCheck,
  LoaderCircle,
  Network,
  Plus,
  Save,
  ServerCog,
  Settings2,
  Sparkles,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

import { getMcpConfig, saveMcpConfig } from '@/renderer/services/mcp';
import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { Textarea } from '@/renderer/components/ui/textarea';
import type {
  McpConfigActionResult,
  McpConfigInspection,
  McpServerConfig,
} from '@/shared/mcp';

type Props = Readonly<{
  sessionDisabled: boolean;
  turnBusy: boolean;
}>;

const emptyStdio = (index: number): McpServerConfig => ({
  id: `server-${index + 1}`,
  transport: 'stdio',
  executable: '',
  argv: [],
  cwd: '',
});

const emptyHttp = (index: number): McpServerConfig => ({
  id: `http-${index + 1}`,
  transport: 'loopbackStreamableHttp',
  endpoint: 'http://127.0.0.1:',
});

const FIGMA_DESKTOP_SERVER: McpServerConfig = {
  id: 'figma-desktop',
  transport: 'loopbackStreamableHttp',
  endpoint: 'http://127.0.0.1:3845/mcp',
};

const noticeFor = (result: McpConfigActionResult): string => {
  switch (result.reason) {
    case 'accepted':
      return '配置已保存。请回到连接面板选择服务并启用。';
    case 'stale':
      return '配置已在其他位置发生变化，已为你刷新，请确认后重新保存。';
    case 'sessionActive':
      return '请先停用当前 MCP 连接，再修改服务配置。';
    case 'turnActive':
      return '请等待当前任务结束或停止后再保存。';
    case 'approvalPending':
      return '请先处理正在等待的 MCP 调用授权。';
    case 'navigationPending':
      return '正在切换任务，请稍后再保存。';
    case 'reconnectPending':
    case 'busy':
      return '本地智能体正在处理其他操作，请稍后重试。';
    case 'invalid':
      return '配置格式不正确，请检查服务名称、路径、参数和本地地址。';
    case 'unavailable':
      return '暂时无法保存 MCP 配置。';
  }
};

export const McpServerManagementWorkbench = ({
  sessionDisabled,
  turnBusy,
}: Props) => {
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] =
    useState<McpConfigInspection | null>(null);
  const [servers, setServers] = useState<readonly McpServerConfig[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const hasFigmaDesktop = servers.some(
    (server) =>
      server.id === FIGMA_DESKTOP_SERVER.id ||
      (server.transport === 'loopbackStreamableHttp' &&
        server.endpoint === FIGMA_DESKTOP_SERVER.endpoint),
  );
  const reachedLimit = servers.length >= 2;
  const editingBlocked = busy || !sessionDisabled || turnBusy;

  useEffect(() => {
    if (!open) {
      return;
    }
    let active = true;
    setBusy(true);
    setNotice(null);
    void getMcpConfig()
      .then((next) => {
        if (active) {
          setInspection(next);
          setServers(next.servers);
          setBusy(false);
        }
      })
      .catch(() => {
        if (active) {
          setNotice('无法读取已保存的 MCP 配置。');
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [open]);

  const update = (index: number, next: McpServerConfig): void => {
    setServers((current) =>
      current.map((server, serverIndex) =>
        serverIndex === index ? next : server,
      ),
    );
  };

  const add = (server: McpServerConfig, message: string): void => {
    setServers((current) => [...current, server]);
    setNotice(message);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!inspection || busy || !sessionDisabled || turnBusy) {
      return;
    }
    setBusy(true);
    setNotice(null);
    void saveMcpConfig({
      expectedRevision: inspection.revision,
      servers,
    })
      .then((result) => {
        if (result.inspection) {
          setInspection(result.inspection);
          setServers(result.inspection.servers);
        }
        setNotice(noticeFor(result));
        setBusy(false);
      })
      .catch(() => {
        setNotice('暂时无法保存 MCP 配置。');
        setBusy(false);
      });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Settings2 aria-hidden="true" />
          配置服务
        </Button>
      </DialogTrigger>
      <DialogContent className="h-[min(46rem,calc(100vh-2rem))] max-w-[52rem]">
        <div className="flex items-start gap-4 border-b px-5 py-4 sm:px-6">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
            <ServerCog className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle className="text-lg font-semibold tracking-[-0.02em]">
                MCP 服务配置
              </DialogTitle>
              <span className="rounded-full border bg-surface px-2 py-0.5 text-[11px] text-secondary">
                {servers.length} / 2
              </span>
            </div>
            <DialogDescription className="mt-1 text-sm text-secondary">
              添加 SugarCode 可以调用的本地工具服务。配置保存后仍需手动启用连接。
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="关闭 MCP 服务配置"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </div>

        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            <section
              className="relative overflow-hidden rounded-2xl border border-brand/25 bg-brand/5 p-4 sm:p-5"
              aria-labelledby="figma-preset-title"
            >
              <div
                className="pointer-events-none absolute -right-8 -top-12 size-32 rounded-full bg-brand/10 blur-2xl"
                aria-hidden="true"
              />
              <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-brand/20 bg-background text-brand shadow-sm">
                  <AppWindowMac className="size-5" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 id="figma-preset-title" className="text-sm font-semibold">
                      Figma Desktop
                    </h3>
                    <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
                      <Sparkles className="size-3" aria-hidden="true" />
                      推荐
                    </span>
                    {hasFigmaDesktop ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                        <BadgeCheck className="size-3" aria-hidden="true" />
                        已添加
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1.5 max-w-xl text-sm leading-6 text-secondary">
                    连接 Figma 桌面端内置的本地 MCP 服务，无需网页登录或 OAuth 授权。
                  </p>
                  <ol className="mt-3 flex flex-wrap gap-2 text-[11px] text-secondary">
                    <li className="rounded-lg border bg-background/70 px-2.5 py-1.5">1. 打开设计文件</li>
                    <li className="rounded-lg border bg-background/70 px-2.5 py-1.5">2. 进入 Dev Mode</li>
                    <li className="rounded-lg border bg-background/70 px-2.5 py-1.5">3. 启用 Desktop MCP</li>
                  </ol>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="sm:self-center"
                  variant={hasFigmaDesktop ? 'outline' : 'default'}
                  disabled={editingBlocked || reachedLimit || hasFigmaDesktop}
                  onClick={() =>
                    add(
                      FIGMA_DESKTOP_SERVER,
                      '已添加 Figma Desktop。保存后回到连接面板启用即可。',
                    )
                  }
                >
                  {hasFigmaDesktop ? <BadgeCheck aria-hidden="true" /> : <Plus aria-hidden="true" />}
                  {hasFigmaDesktop ? '已添加' : '一键添加'}
                </Button>
              </div>
            </section>

            <section className="mt-6" aria-labelledby="configured-servers-title">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h3 id="configured-servers-title" className="text-sm font-medium">已配置服务</h3>
                  <p className="mt-1 text-xs text-secondary">最多配置 2 个服务；本地 HTTP 服务需单独启用。</p>
                </div>
                <span className="text-xs text-tertiary">{servers.length} 个</span>
              </div>

              <fieldset className="mt-3 grid gap-3" disabled={editingBlocked}>
                <legend className="sr-only">已配置的 MCP 服务</legend>
                {servers.length === 0 ? (
                  <div className="flex flex-col items-center rounded-2xl border border-dashed px-5 py-8 text-center">
                    <div className="flex size-10 items-center justify-center rounded-xl bg-surface text-tertiary">
                      <ServerCog className="size-5" aria-hidden="true" />
                    </div>
                    <p className="mt-3 text-sm font-medium">还没有配置服务</p>
                    <p className="mt-1 max-w-sm text-xs leading-5 text-secondary">
                      可以使用上方的 Figma 快捷配置，或添加自定义本地命令与 HTTP 服务。
                    </p>
                  </div>
                ) : null}
                {servers.map((server, index) => {
                  const TransportIcon = server.transport === 'stdio' ? TerminalSquare : Network;
                  return (
                    <div
                      key={`${index}-${server.transport}`}
                      className="rounded-2xl border bg-surface/60 p-4 transition-colors focus-within:border-brand/35"
                    >
                      <div className="mb-4 flex items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background font-mono text-xs text-secondary">
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{server.id || '未命名服务'}</p>
                          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-secondary">
                            <TransportIcon className="size-3" aria-hidden="true" />
                            {server.transport === 'stdio' ? '本地命令进程' : '本地 HTTP 服务'}
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="text-tertiary hover:bg-destructive/10 hover:text-destructive"
                          aria-label={`删除 ${server.id || '该服务'}`}
                          onClick={() =>
                            setServers((current) =>
                              current.filter((_, serverIndex) => serverIndex !== index),
                            )
                          }
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem]">
                        <label className="grid gap-1.5 text-sm">
                          <span>服务名称</span>
                          <Input
                            value={server.id}
                            placeholder="例如 figma-desktop"
                            spellCheck={false}
                            onChange={(event) => update(index, { ...server, id: event.target.value })}
                          />
                          <span className="text-[11px] text-tertiary">用于区分工具来源，仅支持安全的英文标识。</span>
                        </label>
                        <label className="grid content-start gap-1.5 text-sm">
                          <span>连接方式</span>
                          <select
                            className="h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
                            value={server.transport}
                            onChange={(event) => {
                              const transport = event.target.value;
                              update(
                                index,
                                transport === 'stdio'
                                  ? { ...emptyStdio(index), id: server.id }
                                  : { ...emptyHttp(index), id: server.id },
                              );
                            }}
                          >
                            <option value="stdio">本地命令（stdio）</option>
                            <option value="loopbackStreamableHttp">本地 HTTP</option>
                          </select>
                        </label>
                      </div>

                      {server.transport === 'stdio' ? (
                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <label className="grid gap-1.5 text-sm">
                            <span>可执行文件路径</span>
                            <Input
                              value={server.executable}
                              placeholder="/usr/local/bin/node"
                              spellCheck={false}
                              onChange={(event) => update(index, { ...server, executable: event.target.value })}
                            />
                          </label>
                          <label className="grid gap-1.5 text-sm">
                            <span>工作目录</span>
                            <Input
                              value={server.cwd}
                              placeholder="/path/to/project"
                              spellCheck={false}
                              onChange={(event) => update(index, { ...server, cwd: event.target.value })}
                            />
                          </label>
                          <label className="grid gap-1.5 text-sm sm:col-span-2">
                            <span>启动参数</span>
                            <Textarea
                              rows={3}
                              value={server.argv.join('\n')}
                              placeholder={'每行一个参数\n/path/to/server.js'}
                              spellCheck={false}
                              onChange={(event) =>
                                update(index, {
                                  ...server,
                                  argv: event.target.value.split('\n').filter((argument) => argument.length > 0),
                                })
                              }
                            />
                          </label>
                        </div>
                      ) : (
                        <label className="mt-4 grid gap-1.5 text-sm">
                          <span>本地服务地址</span>
                          <Input
                            value={server.endpoint}
                            inputMode="url"
                            placeholder="http://127.0.0.1:3845/mcp"
                            spellCheck={false}
                            onChange={(event) => update(index, { ...server, endpoint: event.target.value })}
                          />
                          <span className="text-[11px] text-tertiary">为保障安全，仅允许 127.0.0.1 或 ::1 回环地址。</span>
                        </label>
                      )}
                    </div>
                  );
                })}
              </fieldset>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={editingBlocked || reachedLimit}
                  onClick={() => add(emptyStdio(servers.length), '已添加本地命令服务，请填写执行路径和启动参数。')}
                >
                  <TerminalSquare aria-hidden="true" />
                  添加本地命令
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={editingBlocked || reachedLimit}
                  onClick={() => add(emptyHttp(servers.length), '已添加本地 HTTP 服务，请填写回环地址。')}
                >
                  <Network aria-hidden="true" />
                  添加本地 HTTP
                </Button>
                {reachedLimit ? (
                  <span className="self-center text-xs text-warning">已达到 2 个服务的上限</span>
                ) : null}
              </div>
            </section>

            <div
              className="mt-5 min-h-10 rounded-xl border bg-surface/50 px-3.5 py-2.5 text-sm text-secondary"
              role="status"
              aria-live="polite"
            >
              {busy ? (
                <span className="flex items-center gap-2">
                  <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  正在读取或校验配置…
                </span>
              ) : !sessionDisabled ? (
                '当前 MCP 连接正在使用中。请先停用连接，再修改服务配置。'
              ) : turnBusy ? (
                '当前任务正在运行，结束或停止后即可保存配置。'
              ) : (
                notice ?? '保存只会更新服务列表，不会自动启用任何连接。'
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-surface/50 px-5 py-4 sm:px-6">
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={busy}>取消</Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !inspection || !sessionDisabled || turnBusy}>
              <Save aria-hidden="true" />
              保存配置
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
