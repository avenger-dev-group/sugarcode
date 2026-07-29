import {
  LoaderCircle,
  Plus,
  Settings2,
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

const noticeFor = (result: McpConfigActionResult): string => {
  switch (result.reason) {
    case 'accepted':
      return 'Configuration saved. MCP remains disabled for this session.';
    case 'stale':
      return 'Configuration changed elsewhere. Review the refreshed values.';
    case 'sessionActive':
      return 'Disable the MCP session before editing server configuration.';
    case 'turnActive':
      return 'Finish or stop the active Turn before saving.';
    case 'approvalPending':
      return 'Resolve the pending approval before saving.';
    case 'navigationPending':
      return 'Wait for Thread navigation to finish before saving.';
    case 'reconnectPending':
    case 'busy':
      return 'Another local Agent operation is still in progress.';
    case 'invalid':
      return 'Review server IDs, paths, arguments, and loopback endpoints.';
    case 'unavailable':
      return 'The MCP configuration could not be saved.';
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
          setNotice('The saved MCP configuration is unavailable.');
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
        setNotice('The MCP configuration could not be saved.');
        setBusy(false);
      });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Settings2 aria-hidden="true" />
          Manage
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[48rem]">
        <div className="flex items-start gap-4 border-b px-5 py-4">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-lg font-semibold tracking-[-0.02em]">
              MCP server registry
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-secondary">
              Edit the local stdio and loopback HTTP servers available to
              future MCP sessions.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Close MCP server registry"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </div>

        <form
          className="min-h-0 overflow-y-auto px-5 py-5"
          onSubmit={submit}
        >
          <fieldset className="grid gap-3" disabled={busy}>
            <legend className="sr-only">Configured MCP servers</legend>
            {servers.length === 0 ? (
              <div className="rounded-xl border border-dashed p-5 text-sm text-secondary">
                No servers configured. Add a stdio or loopback HTTP server to
                make it available in the session gate.
              </div>
            ) : null}
            {servers.map((server, index) => (
              <div
                key={`${index}-${server.transport}`}
                className="rounded-xl border bg-surface p-4"
              >
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem_auto]">
                  <label className="grid gap-1.5 text-sm">
                    <span>Server ID</span>
                    <Input
                      value={server.id}
                      spellCheck={false}
                      onChange={(event) =>
                        update(index, { ...server, id: event.target.value })
                      }
                    />
                  </label>
                  <label className="grid gap-1.5 text-sm">
                    <span>Transport</span>
                    <select
                      className="h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
                      value={server.transport}
                      onChange={(event) => {
                        const transport = event.target.value;
                        update(
                          index,
                          transport === 'stdio'
                            ? emptyStdio(index)
                            : {
                                id: server.id,
                                transport: 'loopbackStreamableHttp',
                                endpoint: 'http://127.0.0.1:',
                              },
                        );
                      }}
                    >
                      <option value="stdio">stdio</option>
                      <option value="loopbackStreamableHttp">
                        loopback HTTP
                      </option>
                    </select>
                  </label>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="self-end"
                    aria-label={`Remove ${server.id || 'server'}`}
                    onClick={() =>
                      setServers((current) =>
                        current.filter(
                          (_, serverIndex) => serverIndex !== index,
                        ),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
                {server.transport === 'stdio' ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-sm">
                      <span>Executable path</span>
                      <Input
                        value={server.executable}
                        spellCheck={false}
                        onChange={(event) =>
                          update(index, {
                            ...server,
                            executable: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                      <span>Working directory</span>
                      <Input
                        value={server.cwd}
                        spellCheck={false}
                        onChange={(event) =>
                          update(index, {
                            ...server,
                            cwd: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm sm:col-span-2">
                      <span>Arguments · one per line</span>
                      <Textarea
                        rows={3}
                        value={server.argv.join('\n')}
                        spellCheck={false}
                        onChange={(event) =>
                          update(index, {
                            ...server,
                            argv: event.target.value
                              .split('\n')
                              .filter((argument) => argument.length > 0),
                          })
                        }
                      />
                    </label>
                  </div>
                ) : (
                  <label className="mt-3 grid gap-1.5 text-sm">
                    <span>Loopback endpoint</span>
                    <Input
                      value={server.endpoint}
                      inputMode="url"
                      spellCheck={false}
                      onChange={(event) =>
                        update(index, {
                          ...server,
                          endpoint: event.target.value,
                        })
                      }
                    />
                  </label>
                )}
              </div>
            ))}
          </fieldset>

          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={busy || servers.length >= 2}
            onClick={() =>
              setServers((current) => [
                ...current,
                emptyStdio(current.length),
              ])
            }
          >
            <Plus aria-hidden="true" />
            Add server
          </Button>

          <div
            className="mt-4 min-h-10 rounded-lg border px-3 py-2 text-sm text-secondary"
            role="status"
            aria-live="polite"
          >
            {busy ? (
              <span className="flex items-center gap-2">
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Reading or validating configuration…
              </span>
            ) : !sessionDisabled ? (
              'Disable the current MCP session before saving registry changes.'
            ) : (
              notice ??
              'Saving replaces the registry atomically and leaves MCP disabled.'
            )}
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={busy}>
                Close
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={
                busy || !inspection || !sessionDisabled || turnBusy
              }
            >
              Save registry
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
