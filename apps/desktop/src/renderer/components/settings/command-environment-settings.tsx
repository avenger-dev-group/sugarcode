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
      return '尚未捕获';
    case 'capturing':
      return '正在捕获';
    case 'ready':
      return '就绪';
    case 'degraded':
      return '正在使用进程环境';
    case 'failed':
      return '不可用';
  }
};

const sourceLabel = (status: CommandEnvironmentStatus): string =>
  status.source === 'shellProfile' ? 'Shell 配置' : 'SugarCode 进程';

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
        if (active) setError('无法获取命令环境状态。');
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
        if (active) setError('无法获取任务工作区状态。');
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
        setError('无法刷新命令环境。');
      } else {
        setStatus(result.status);
      }
    } catch {
      setError('无法刷新命令环境。');
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
        setError('无法更新 Shell 配置读取选项。');
      } else if (result.status) {
        setStatus(result.status);
      } else {
        setStatus((current) =>
          current ? { ...current, profileLoadingEnabled: enabled } : current
        );
      }
    } catch {
      setError('无法更新 Shell 配置读取选项。');
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
        setError('无法切换任务工作区模式。');
      } else {
        setTaskWorkspace(result.workspace);
      }
    } catch {
      setError(
        mode === 'worktree'
          ? '无法创建 Git 工作树。请确认当前项目是仓库根目录，并且至少有一次提交。'
          : '任务无法返回本地项目目录。',
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
            命令环境
          </h3>
          <p className="mt-1 text-sm text-secondary">
            代理首次执行命令时，才会读取并保存 Shell 配置。
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
          刷新
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
          <span className="block text-sm font-medium">读取 Shell 配置</span>
          <span className="mt-0.5 block text-xs text-secondary">
            从常用终端配置中加载导出的 PATH 变更。
          </span>
        </span>
      </label>

      {workspaceId ? (
        <div className="mt-3 rounded-lg border bg-surface/35 p-3 text-xs">
          <div className="flex items-center gap-2">
            <SquareTerminal className="size-3.5 text-tertiary" aria-hidden="true" />
            <span className="font-medium">{status ? statusLabel(status) : '正在加载状态'}</span>
            {status ? (
              <code className="ml-auto max-w-[55%] truncate text-tertiary" title={status.shell.executable}>
                {status.shell.executable}
              </code>
            ) : null}
          </div>
          {status?.createdAt ? (
            <p className="mt-2 text-tertiary">
              捕获于 {new Date(status.createdAt).toLocaleString('zh-CN')} · {sourceLabel(status)} · {status.shell.kind} · {status.variableCount} 个变量 · 已过滤 {status.filteredVariableCount} 个
            </p>
          ) : null}
          {status && status.pathEntries.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-secondary">
                有效 PATH（{status.pathEntries.length} 项）
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
          打开一个项目后即可查看其命令环境。
        </p>
      )}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

      <div className="mt-5 border-t pt-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <GitBranch className="size-4" aria-hidden="true" />
              任务工作区
            </h3>
            <p className="mt-1 text-sm text-secondary">
              本地任务共享项目目录；工作树任务使用独立的 Git 分支和目录。
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
                {mode === 'local' ? '本地' : '工作树'}
              </Button>
            ))}
          </div>
        </div>
        {taskWorkspace ? (
          <div className="mt-3 rounded-lg border bg-surface/35 p-3 text-xs text-tertiary">
            <p className="break-all font-mono">{taskWorkspace.root}</p>
            {taskWorkspace.branch ? (
              <p className="mt-1 break-all">分支：<code>{taskWorkspace.branch}</code></p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
};
