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
      case 'knowledge_search': {
        const query = boundedProgressValue(argumentsValue.query);
        return query ? `正在已选择的知识库中检索“${query}”。` : '正在检索本地知识库。';
      }
      case 'knowledge_list_documents':
        return '正在查看已选择知识库的文档清单。';
      case 'knowledge_read':
        return '正在读取知识库命中文档的连续片段。';
      case 'workspace_apply_patch':
        return '正在更新项目文件。';
      case 'drawio_generate':
        return paths[0] ? `正在生成 ${pathBasename(paths[0])} 图表。` : '正在生成 Draw.io 图表。';
      case 'shell_exec':
        return '正在运行项目命令。';
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
    case 'knowledge_search': {
      const query = boundedProgressValue(argumentsValue.query);
      return query ? `Searching selected knowledge for “${query}”.` : 'Searching local knowledge.';
    }
    case 'knowledge_list_documents':
      return 'Listing documents in the selected knowledge bases.';
    case 'knowledge_read':
      return 'Reading adjacent chunks from a knowledge document.';
    case 'workspace_apply_patch':
      return 'Updating project files.';
    case 'drawio_generate':
      return paths[0] ? `Generating the ${pathBasename(paths[0])} diagram.` : 'Generating a Draw.io diagram.';
    case 'shell_exec':
      return 'Running a project command.';
    case INVALID_TOOL_ARGUMENTS_TOOL_NAME:
      return 'Adjusting an invalid tool argument format.';
    default:
      return undefined;
  }
};
