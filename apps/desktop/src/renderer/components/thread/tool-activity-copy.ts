import type { CompactToolActivity, ProcessLanguage } from './types';

const countByType = (
  activities: readonly CompactToolActivity[],
  type: CompactToolActivity['type'],
): number => activities.filter((entry) => entry.type === type).length;

export const toolActivityGroupSummary = (
  activities: readonly CompactToolActivity[],
  language: ProcessLanguage = 'en',
): string => {
  const parts: string[] = [];
  const listCount = countByType(activities, 'workspaceList');
  const readCount = countByType(activities, 'workspaceRead');
  const searchCount = countByType(activities, 'workspaceSearch');
  const editCount = countByType(activities, 'fileChange');
  const patchFileCount = activities.reduce(
    (total, entry) =>
      entry.type === 'commandApproval' &&
      entry.activity.executionResult?.outcome.type === 'workspacePatch'
        ? total + entry.activity.executionResult.outcome.filesChanged
        : total,
    0,
  );
  const failedPatchCount = activities.filter(
    (entry) =>
      entry.type === 'commandApproval' &&
      entry.activity.command.startsWith('workspace_apply_patch') &&
      (entry.activity.executionResult?.outcome.type === 'error' ||
        entry.activity.state === 'denied' ||
        entry.activity.state === 'timedOut' ||
        entry.activity.state === 'unsupported'),
  ).length;
  const ranCommandCount = activities.filter(
    (entry) =>
      entry.type === 'commandApproval' &&
      !entry.activity.command.startsWith('workspace_apply_patch') &&
      entry.activity.executionResult !== undefined,
  ).length;
  const reviewedCommandCount = activities.filter(
    (entry) =>
      entry.type === 'commandApproval' &&
      !entry.activity.command.startsWith('workspace_apply_patch') &&
      entry.activity.executionResult === undefined,
  ).length;
  const calledMcpCount = activities.filter(
    (entry) => entry.type === 'mcp' && entry.activity.state !== 'denied',
  ).length;
  const reviewedMcpCount = countByType(activities, 'mcp') - calledMcpCount;
  if (language === 'zh') {
    if (listCount > 0) {
      parts.push(`已列出 ${listCount} 个目录`);
    }
    if (readCount > 0) {
      parts.push(`已读取 ${readCount} 个文件`);
    }
    if (searchCount > 0) {
      parts.push(`完成 ${searchCount} 次搜索`);
    }
    if (editCount > 0) {
      parts.push(`编辑了 ${editCount} 个文件`);
    }
    if (patchFileCount > 0) {
      parts.push(`已修改 ${patchFileCount} 个文件`);
    }
    if (failedPatchCount > 0) {
      parts.push(`${failedPatchCount} 次修改失败`);
    }
    if (ranCommandCount > 0) {
      parts.push(`运行了 ${ranCommandCount} 条命令`);
    }
    if (reviewedCommandCount > 0) {
      parts.push(`审核了 ${reviewedCommandCount} 条命令`);
    }
    if (calledMcpCount > 0) {
      parts.push(`调用了 ${calledMcpCount} 个工具`);
    }
    if (reviewedMcpCount > 0) {
      parts.push(`审核了 ${reviewedMcpCount} 个工具调用`);
    }
    return parts.length > 0 ? parts.join('、') : '已处理工作区';
  }
  if (listCount > 0) {
    parts.push(
      listCount === 1
        ? 'listed a directory'
        : `listed ${listCount} directories`,
    );
  }
  if (readCount > 0) {
    parts.push(`read ${readCount} ${readCount === 1 ? 'file' : 'files'}`);
  }
  if (searchCount > 0) {
    parts.push(
      searchCount === 1
        ? 'searched the workspace'
        : `ran ${searchCount} searches`,
    );
  }
  if (editCount > 0) {
    parts.push(`edited ${editCount} ${editCount === 1 ? 'file' : 'files'}`);
  }
  if (patchFileCount > 0) {
    parts.push(
      `changed ${patchFileCount} ${patchFileCount === 1 ? 'file' : 'files'}`,
    );
  }
  if (failedPatchCount > 0) {
    parts.push(
      `${failedPatchCount} failed ${failedPatchCount === 1 ? 'edit' : 'edits'}`,
    );
  }
  if (ranCommandCount > 0) {
    parts.push(
      `ran ${ranCommandCount} ${
        ranCommandCount === 1 ? 'command' : 'commands'
      }`,
    );
  }
  if (reviewedCommandCount > 0) {
    parts.push(
      `reviewed ${reviewedCommandCount} ${
        reviewedCommandCount === 1 ? 'command' : 'commands'
      }`,
    );
  }
  if (calledMcpCount > 0) {
    parts.push(
      `called ${calledMcpCount} ${
        calledMcpCount === 1 ? 'tool' : 'tools'
      }`,
    );
  }
  if (reviewedMcpCount > 0) {
    parts.push(
      `reviewed ${reviewedMcpCount} ${
        reviewedMcpCount === 1 ? 'tool call' : 'tool calls'
      }`,
    );
  }
  if (parts.length === 0) {
    return 'Worked in the workspace';
  }
  const sentence = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};
