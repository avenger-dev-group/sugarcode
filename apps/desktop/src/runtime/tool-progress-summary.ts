import { INVALID_TOOL_ARGUMENTS_TOOL_NAME } from './models/types.ts';

const boundedProgressValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, 120)
    : undefined;

const progressPaths = (
  argumentsValue: Readonly<Record<string, unknown>>,
): readonly string[] => {
  const path = boundedProgressValue(argumentsValue.path);
  if (path) {
    return [path];
  }
  return Array.isArray(argumentsValue.paths)
    ? argumentsValue.paths
      .map(boundedProgressValue)
      .filter((entry): entry is string => Boolean(entry))
    : [];
};

const pathBasename = (path: string): string =>
  path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? path;

export const toolProgressSummary = (
  userText: string,
  toolName: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): string | undefined => {
  const chinese = /\p{Script=Han}/u.test(userText);
  const paths = progressPaths(argumentsValue);
  const readSummary = paths.length > 3
    ? chinese
      ? `${paths.length} 个项目文件`
      : `${paths.length} project files`
    : paths.map(pathBasename).join(chinese ? '、' : ', ');
  if (chinese) {
    switch (toolName) {
      case 'workspace_list':
        return `正在查看${paths[0] && paths[0] !== '.' ? ` ${paths[0]}` : '项目根目录'}的目录结构。`;
      case 'workspace_read':
        return readSummary ? `正在读取 ${readSummary}。` : '正在读取项目文件。';
      case 'workspace_search': {
        const query = boundedProgressValue(argumentsValue.query);
        return query ? `正在项目中搜索“${query}”。` : '正在搜索项目代码。';
      }
      case 'workspace_apply_patch':
        return '正在更新项目文件。';
      case 'shell_exec':
        return '正在运行项目命令。';
      case 'load_skill': {
        const name = boundedProgressValue(argumentsValue.name);
        return name ? `正在加载 Skill：${name}。` : '正在加载 Skill。';
      }
      case INVALID_TOOL_ARGUMENTS_TOOL_NAME:
        return '工具参数格式不正确，正在调整调用方式。';
      default:
        return undefined;
    }
  }
  switch (toolName) {
    case 'workspace_list':
      return `Inspecting the ${paths[0] && paths[0] !== '.' ? `${paths[0]} directory` : 'project root'}.`;
    case 'workspace_read':
      return readSummary ? `Reading ${readSummary}.` : 'Reading project files.';
    case 'workspace_search': {
      const query = boundedProgressValue(argumentsValue.query);
      return query ? `Searching the project for “${query}”.` : 'Searching the project code.';
    }
    case 'workspace_apply_patch':
      return 'Updating project files.';
    case 'shell_exec':
      return 'Running a project command.';
    case 'load_skill': {
      const name = boundedProgressValue(argumentsValue.name);
      return name ? `Loading the ${name} Skill.` : 'Loading a Skill.';
    }
    case INVALID_TOOL_ARGUMENTS_TOOL_NAME:
      return 'Adjusting an invalid tool argument format.';
    default:
      return undefined;
  }
};
