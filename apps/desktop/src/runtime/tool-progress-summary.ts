import { INVALID_TOOL_ARGUMENTS_TOOL_NAME } from './models/types.ts';
import { ANALYZE_IMAGE_TOOL_NAME } from './media-analysis.ts';
import { ANALYZE_VIDEO_TOOL_NAME } from './video-analysis.ts';

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

const videoProgressSummary = (
  chinese: boolean,
  mode: unknown,
): string => {
  switch (mode) {
    case 'native':
      return chinese
        ? '正在使用所配置模型的原生视频能力分析完整视频。'
        : 'Analyzing the complete video with the configured model’s native video capability.';
    case 'meeting':
      return chinese
        ? '正在分析完整视频、转写音轨并区分说话人。'
        : 'Analyzing the complete video, transcribing its audio, and identifying speakers.';
    case 'visual':
      return chinese
        ? '正在提取并分析视频画面；此模式不处理音频。'
        : 'Extracting and analyzing video frames; audio is excluded in this mode.';
    default:
      return chinese
        ? '正在优先使用原生视频能力分析；不可用时将处理画面和音轨。'
        : 'Trying native video analysis first, with visual and audio processing as fallback.';
  }
};

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
      case 'browser': {
        const action = boundedProgressValue(argumentsValue.action);
        const labels: Readonly<Record<string, string>> = {
          open: '正在打开本地预览页面。',
          snapshot: '正在读取浏览器页面。',
          click: '正在操作浏览器页面。',
          type: '正在向浏览器页面输入内容。',
          wait: '正在等待浏览器页面更新。',
          screenshot: '正在截取浏览器画面。',
          close: '正在关闭浏览器页面。',
        };
        return action ? labels[action] ?? '正在使用内置浏览器。' : '正在使用内置浏览器。';
      }
      case ANALYZE_IMAGE_TOOL_NAME:
        return '正在分析图片内容。';
      case ANALYZE_VIDEO_TOOL_NAME:
        return videoProgressSummary(true, argumentsValue.mode);
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
    case 'browser': {
      const action = boundedProgressValue(argumentsValue.action);
      const labels: Readonly<Record<string, string>> = {
        open: 'Opening the local preview page.',
        snapshot: 'Reading the browser page.',
        click: 'Interacting with the browser page.',
        type: 'Entering text in the browser page.',
        wait: 'Waiting for the browser page to update.',
        screenshot: 'Capturing the browser page.',
        close: 'Closing the browser page.',
      };
      return action ? labels[action] ?? 'Using the built-in browser.' : 'Using the built-in browser.';
    }
    case ANALYZE_IMAGE_TOOL_NAME:
      return 'Analyzing the image content.';
    case ANALYZE_VIDEO_TOOL_NAME:
      return videoProgressSummary(false, argumentsValue.mode);
    case INVALID_TOOL_ARGUMENTS_TOOL_NAME:
      return 'Adjusting an invalid tool argument format.';
    default:
      return undefined;
  }
};

const safeSpeakerCount = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;

export const toolResultSummary = (
  userText: string,
  toolName: string,
  result: Readonly<Record<string, unknown>>,
): string | undefined => {
  if (toolName !== ANALYZE_VIDEO_TOOL_NAME) {
    return undefined;
  }
  const chinese = /\p{Script=Han}/u.test(userText);
  if (result.ok !== true) {
    return chinese ? '视频分析未完成，请查看错误详情。' : 'Video analysis did not complete; see the error details.';
  }
  const transport = result.transport;
  const source = result.nativeSource;
  const speakers = safeSpeakerCount(result.speakerCount);
  const speakerDetail = speakers === undefined
    ? ''
    : chinese
      ? `，识别 ${speakers} 位说话人`
      : ` with ${speakers} identified speaker${speakers === 1 ? '' : 's'}`;
  if (transport === 'directVideo') {
    const sourceDetail = source === 'temporaryUrl'
      ? chinese ? '临时 URL' : 'temporary URL'
      : chinese ? '请求内嵌' : 'inline request';
    return chinese
      ? `视频分析已完成：原生视频模型（${sourceDetail}），包含视频内音轨。`
      : `Video analysis completed with the native video model (${sourceDetail}), including the video audio track.`;
  }
  if (transport === 'hybrid') {
    const visual = source
      ? chinese ? '原生视频' : 'native video'
      : chinese ? '抽帧画面' : 'extracted frames';
    return chinese
      ? `视频分析已完成：${visual} + 独立音轨转写${speakerDetail}。`
      : `Video analysis completed with ${visual} plus separate audio transcription${speakerDetail}.`;
  }
  if (transport === 'extractedFrames') {
    return chinese
      ? '视频分析已完成：原生视频不可用，已使用抽帧画面；未获得可用音频转写。'
      : 'Video analysis completed with extracted frames because native video was unavailable; no usable audio transcript was obtained.';
  }
  return undefined;
};
