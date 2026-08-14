import { useEffect, useState } from 'react';
import { GitBranch, LoaderCircle, RefreshCw, SquareTerminal } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { Checkbox } from '@/renderer/components/ui/checkbox';
import {
  getCommandEnvironment,
  getTaskWorkspace,
  refreshCommandEnvironment,
  setCommandEnvironmentProfileLoading,
  setTaskWorkspaceMode,
} from '@/renderer/services/command-environment';
import type {
  CommandEnvironmentStatus,
  TaskWorkspaceStatus,
} from '@/shared/command-environment';

type Props = Readonly<{
  workspaceId?: string;
  threadId?: string;
}>;

const statusLabel = (status: CommandEnvironmentStatus): string => {
  switch (status.state) {
    case 'notCaptured':
      return 'Not captured yet';
    case 'capturing':
      return 'Capturing';
    case 'ready':
      return 'Ready';
    case 'degraded':
      return 'Using process fallback';
    case 'failed':
      return 'Unavailable';
  }
};

const sourceLabel = (status: CommandEnvironmentStatus): string =>
  status.source === 'shellProfile' ? 'Shell profile' : 'SugarCode process';

export const CommandEnvironmentSettings = ({
  workspaceId,
  threadId,
}: Props) => {
  const [status, setStatus] = useState<CommandEnvironmentStatus | null>(null);
  const [taskWorkspace, setTaskWorkspace] = useState<TaskWorkspaceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setStatus(null);
      setError(null);
      return undefined;
    }
    let active = true;
    void getCommandEnvironment({
      workspaceId,
      ...(threadId ? { threadId } : {}),
    })
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setError('Command environment status is unavailable.');
      });
    return () => {
      active = false;
    };
  }, [threadId, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !threadId) {
      setTaskWorkspace(null);
      return undefined;
    }
    let active = true;
    void getTaskWorkspace({ workspaceId, threadId })
      .then((next) => {
        if (active) setTaskWorkspace(next);
      })
      .catch(() => {
        if (active) setError('Task workspace status is unavailable.');
      });
    return () => {
      active = false;
    };
  }, [threadId, workspaceId]);

  const refresh = async (): Promise<void> => {
    if (!workspaceId || !threadId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await refreshCommandEnvironment({ workspaceId, threadId });
      if (!result.accepted || !result.status) {
        setError('The command environment could not be refreshed.');
      } else {
        setStatus(result.status);
      }
    } catch {
      setError('The command environment could not be refreshed.');
    } finally {
      setBusy(false);
    }
  };

  const setProfileLoading = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await setCommandEnvironmentProfileLoading({
        enabled,
        ...(workspaceId ? { workspaceId } : {}),
        ...(threadId ? { threadId } : {}),
      });
      if (!result.accepted) {
        setError('The Shell profile preference could not be updated.');
      } else if (result.status) {
        setStatus(result.status);
      } else {
        setStatus((current) =>
          current ? { ...current, profileLoadingEnabled: enabled } : current
        );
      }
    } catch {
      setError('The Shell profile preference could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const changeTaskWorkspace = async (
    mode: TaskWorkspaceStatus['mode'],
  ): Promise<void> => {
    if (!workspaceId || !threadId || taskWorkspace?.mode === mode) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setTaskWorkspaceMode({ workspaceId, threadId, mode });
      if (!result.accepted || !result.workspace) {
        setError('The task workspace mode could not be changed.');
      } else {
        setTaskWorkspace(result.workspace);
      }
    } catch {
      setError(
        mode === 'worktree'
          ? 'A Git worktree could not be created. Confirm the project is the repository root and has an initial commit.'
          : 'The task could not return to the local project.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="command-environment-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id="command-environment-title" className="text-sm font-medium">
            Command environment
          </h3>
          <p className="mt-1 text-sm text-secondary">
            Shell profiles are captured lazily when an Agent first runs a command.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !workspaceId || !threadId}
          onClick={() => void refresh()}
        >
          {busy ? (
            <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
          Refresh
        </Button>
      </div>

      <label className="mt-4 flex items-start gap-3 rounded-lg border p-3">
        <Checkbox
          checked={status?.profileLoadingEnabled ?? true}
          disabled={busy}
          onCheckedChange={(checked) =>
            void setProfileLoading(checked === true)
          }
        />
        <span>
          <span className="block text-sm font-medium">Read Shell profile</span>
          <span className="mt-0.5 block text-xs text-secondary">
            Loads exported PATH changes from your normal terminal configuration.
          </span>
        </span>
      </label>

      {workspaceId ? (
        <div className="mt-3 rounded-lg border bg-surface/35 p-3 text-xs">
          <div className="flex items-center gap-2">
            <SquareTerminal className="size-3.5 text-tertiary" aria-hidden="true" />
            <span className="font-medium">{status ? statusLabel(status) : 'Loading status'}</span>
            {status ? (
              <code className="ml-auto max-w-[55%] truncate text-tertiary" title={status.shell.executable}>
                {status.shell.executable}
              </code>
            ) : null}
          </div>
          {status?.createdAt ? (
            <p className="mt-2 text-tertiary">
              Captured {new Date(status.createdAt).toLocaleString()} · {sourceLabel(status)} · {status.shell.kind} · {status.variableCount} variables · {status.filteredVariableCount} filtered
            </p>
          ) : null}
          {status && status.pathEntries.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-secondary">
                Effective PATH ({status.pathEntries.length})
              </summary>
              <div className="mt-2 max-h-32 space-y-1 overflow-auto font-mono text-[11px] text-tertiary">
                {status.pathEntries.map((entry, index) => (
                  <div key={`${entry}:${index}`} className="break-all">{entry}</div>
                ))}
              </div>
            </details>
          ) : null}
          {status?.lastError ? (
            <p className="mt-2 break-words text-warning">{status.lastError}</p>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-tertiary">
          Open a project to inspect its command environment.
        </p>
      )}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

      <div className="mt-5 border-t pt-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <GitBranch className="size-4" aria-hidden="true" />
              Task workspace
            </h3>
            <p className="mt-1 text-sm text-secondary">
              Local tasks share the project directory. Worktree tasks use an isolated Git branch and directory.
            </p>
          </div>
          <div className="flex rounded-lg border p-0.5">
            {(['local', 'worktree'] as const).map((mode) => (
              <Button
                key={mode}
                type="button"
                size="sm"
                variant={taskWorkspace?.mode === mode ? 'secondary' : 'ghost'}
                disabled={busy || !workspaceId || !threadId || !taskWorkspace}
                onClick={() => void changeTaskWorkspace(mode)}
              >
                {mode === 'local' ? 'Local' : 'Worktree'}
              </Button>
            ))}
          </div>
        </div>
        {taskWorkspace ? (
          <div className="mt-3 rounded-lg border bg-surface/35 p-3 text-xs text-tertiary">
            <p className="break-all font-mono">{taskWorkspace.root}</p>
            {taskWorkspace.branch ? (
              <p className="mt-1 break-all">Branch: <code>{taskWorkspace.branch}</code></p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
};
