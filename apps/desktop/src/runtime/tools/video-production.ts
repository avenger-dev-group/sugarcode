import { FunctionTool } from '@google/adk';
import { Type, type Schema } from '@google/genai';
import { existsSync } from 'node:fs';
import { isAbsolute, normalize, posix, relative, win32 } from 'node:path';

import type { NativeRuntimeBinding } from '../persistence/native.ts';
import { executePrivilegedWorkspaceTool } from './workspace.ts';

export const VIDEO_RUNTIME_PREPARE_TOOL_NAME = 'video_runtime_prepare';
export const VIDEO_RENDER_TOOL_NAME = 'video_render';
export const VIDEO_VOICEOVER_TOOL_NAME = 'video_voiceover';
export const VIDEO_AUDIO_MIX_TOOL_NAME = 'video_audio_mix';

const DEFAULT_PROJECT_DIRECTORY = '.sugarcode/video';
const RUNTIME_DIRECTORY_NAME = 'remotion-v4';
const MAX_RENDER_TIMEOUT_MS = 600_000;

type RunPrivileged = (
  toolName: string,
  argumentsValue: Readonly<Record<string, unknown>>,
  execute: (operationId: string) => Promise<unknown>,
) => Promise<unknown>;

type VideoProductionToolOptions = Readonly<{
  nativeRuntime: NativeRuntimeBinding;
  workspaceId: string;
  threadId: string;
  dataDirectory: string;
  ffmpegPath?: string;
  runPrivileged: RunPrivileged;
  onCommandOutput?: (
    operationId: string,
    stream: 'stdout' | 'stderr',
    delta: string,
  ) => void;
  platform?: NodeJS.Platform;
}>;

const workspacePathProperty = (description: string) => ({
  type: Type.STRING,
  description,
}) satisfies Schema;

const prepareSchema = {
  type: Type.OBJECT,
  properties: {},
  description:
    `SugarCode connects the shared runtime to ${DEFAULT_PROJECT_DIRECTORY}; no arguments are required.`,
} satisfies Schema;

const renderSchema = {
  type: Type.OBJECT,
  properties: {
    entry: workspacePathProperty(
      `Workspace-relative Remotion entry file under ${DEFAULT_PROJECT_DIRECTORY}.`,
    ),
    compositionId: {
      type: Type.STRING,
      description: 'Exact Remotion composition id to render.',
    },
    outputPath: workspacePathProperty(
      'Workspace-relative output ending in .mp4, .webm, or .mov. Prefer renders/<name>.mp4.',
    ),
    quality: {
      type: Type.STRING,
      enum: ['sample', 'final'],
      description:
        'sample renders the first 90 frames at reduced JPEG quality; final renders the complete composition.',
    },
    overwrite: {
      type: Type.BOOLEAN,
      description: 'Whether an existing output may be replaced. Defaults to false.',
    },
  },
  required: ['entry', 'compositionId', 'outputPath', 'quality'],
} satisfies Schema;

const voiceoverSchema = {
  type: Type.OBJECT,
  properties: {
    scriptPath: workspacePathProperty(
      'Workspace-relative UTF-8 text file containing narration. Write and review this file before calling the tool.',
    ),
    outputPath: workspacePathProperty(
      'Workspace-relative .wav output path. Prefer assets/audio/<name>.wav.',
    ),
    voice: {
      type: Type.STRING,
      description:
        'Optional installed system voice name. Omit to use the operating-system default voice.',
    },
    rate: {
      type: Type.INTEGER,
      description: 'Optional speaking rate from 80 through 360 words per minute.',
    },
    overwrite: {
      type: Type.BOOLEAN,
      description: 'Whether an existing output may be replaced. Defaults to false.',
    },
  },
  required: ['scriptPath', 'outputPath'],
} satisfies Schema;

const mixSchema = {
  type: Type.OBJECT,
  properties: {
    videoPath: workspacePathProperty('Workspace-relative source video path.'),
    narrationPath: workspacePathProperty(
      'Optional workspace-relative narration audio path.',
    ),
    musicPath: workspacePathProperty(
      'Optional workspace-relative background music path.',
    ),
    outputPath: workspacePathProperty(
      'Workspace-relative .mp4 or .mov output path. Prefer renders/<name>-with-audio.mp4.',
    ),
    narrationVolume: {
      type: Type.NUMBER,
      description: 'Narration volume multiplier from 0 through 4. Defaults to 1.',
    },
    musicVolume: {
      type: Type.NUMBER,
      description: 'Background music multiplier from 0 through 1. Defaults to 0.18.',
    },
    overwrite: {
      type: Type.BOOLEAN,
      description: 'Whether an existing output may be replaced. Defaults to false.',
    },
  },
  required: ['videoPath', 'outputPath'],
} satisfies Schema;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringArgument = (
  input: unknown,
  name: string,
  optional = false,
): string | undefined => {
  if (!isRecord(input)) {
    throw new Error('Tool arguments must be one JSON object.');
  }
  const value = input[name];
  if (value === undefined && optional) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
};

const booleanArgument = (input: unknown, name: string): boolean => {
  if (!isRecord(input) || input[name] === undefined) {
    return false;
  }
  if (typeof input[name] !== 'boolean') {
    throw new Error(`${name} must be a boolean.`);
  }
  return input[name];
};

const numberArgument = (
  input: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (!isRecord(input) || input[name] === undefined) {
    return fallback;
  }
  const value = input[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
};

export const safeVideoWorkspacePath = (
  value: string,
  extensions?: readonly string[],
): string => {
  if (
    value.length > 1_024 ||
    isAbsolute(value) ||
    value.includes('\0') ||
    /[\r\n]/u.test(value)
  ) {
    throw new Error('Use a safe workspace-relative path.');
  }
  const normalized = normalize(value).replaceAll('\\', '/').replace(/^\.\//u, '');
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error('Use a safe workspace-relative path.');
  }
  if (
    extensions &&
    !extensions.some((extension) => normalized.toLowerCase().endsWith(extension))
  ) {
    throw new Error(`Path must end in ${extensions.join(', ')}.`);
  }
  return normalized;
};

const ensureEntryInProjectDirectory = (
  entry: string,
  projectDirectory: string,
): void => {
  const child = relative(projectDirectory, entry).replaceAll('\\', '/');
  if (child === '..' || child.startsWith('../') || isAbsolute(child)) {
    throw new Error(`entry must be inside ${projectDirectory}.`);
  }
};

const posixQuote = (value: string): string => {
  const escaped = value.replaceAll("'", `'"'"'`);
  return `'${escaped}'`;
};

const powershellQuote = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

// Command builders can target a different platform from the host running them.
const platformPaths = (platform: NodeJS.Platform) =>
  platform === 'win32' ? win32 : posix;

const executablePath = (runtimeRoot: string, platform: NodeJS.Platform): string =>
  platformPaths(platform).join(
    runtimeRoot,
    'node_modules',
    '.bin',
    platform === 'win32' ? 'remotion.cmd' : 'remotion',
  );

const ffprobeExecutable = (
  ffmpegPath: string | undefined,
  platform: NodeJS.Platform,
): string => {
  if (!ffmpegPath) {
    return 'ffprobe';
  }
  const paths = platformPaths(platform);
  const candidate = paths.join(
    paths.dirname(ffmpegPath),
    platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
  );
  return existsSync(candidate) ? candidate : 'ffprobe';
};

const outputDirectory = (path: string, platform: NodeJS.Platform): string => {
  const directory = platformPaths(platform).dirname(path).replaceAll('\\', '/');
  return directory === '.' ? '.' : directory;
};

const shellResultSucceeded = (result: unknown): boolean => {
  if (!isRecord(result) || result.status !== 'completed' || !isRecord(result.output)) {
    return false;
  }
  const outcome = result.output.outcome;
  return isRecord(outcome) && outcome.type === 'exitCode' && outcome.code === 0;
};

const shellResultDetail = (result: unknown): Readonly<Record<string, unknown>> =>
  isRecord(result)
    ? result
    : { result };

export const managedVideoRuntimeRoot = (
  dataDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string => platformPaths(platform).resolve(dataDirectory, 'video-runtime', RUNTIME_DIRECTORY_NAME);

export const buildVideoRuntimePrepareCommand = (
  runtimeRoot: string,
  projectDirectory: string,
  platform: NodeJS.Platform,
): string => {
  const paths = platformPaths(platform);
  const cliPath = executablePath(runtimeRoot, platform);
  const modulePath = paths.join(runtimeRoot, 'node_modules');
  if (platform === 'win32') {
    const manifest = JSON.stringify({ name: 'sugarcode-video-runtime', private: true });
    return [
      `$runtime=${powershellQuote(runtimeRoot)}`,
      `$project=${powershellQuote(projectDirectory)}`,
      `$modules=${powershellQuote(modulePath)}`,
      `New-Item -ItemType Directory -Force -Path $runtime,$project,(Join-Path $project 'public') | Out-Null`,
      `if (-not (Test-Path ${powershellQuote(cliPath)})) { Set-Content -LiteralPath (Join-Path $runtime 'package.json') -Value ${powershellQuote(manifest)} -Encoding UTF8; npm install --prefix $runtime --package-lock --save-exact remotion@4 @remotion/cli@4 react@18.3.1 react-dom@18.3.1; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }`,
      `& ${powershellQuote(cliPath)} versions; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
      `& ${powershellQuote(cliPath)} browser ensure; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
      `$link=Join-Path $project 'node_modules'`,
      `if (-not (Test-Path $link)) { New-Item -ItemType Junction -Path $link -Target $modules | Out-Null }`,
    ].join('; ');
  }
  const manifestScript = `const fs=require('node:fs');const path=process.argv[1];if(!fs.existsSync(path))fs.writeFileSync(path,JSON.stringify({name:'sugarcode-video-runtime',private:true})+'\\n')`;
  return [
    `mkdir -p ${posixQuote(runtimeRoot)} ${posixQuote(projectDirectory)} ${posixQuote(paths.join(projectDirectory, 'public'))}`,
    `node -e ${posixQuote(manifestScript)} ${posixQuote(paths.join(runtimeRoot, 'package.json'))}`,
    `[ -x ${posixQuote(cliPath)} ] || npm install --prefix ${posixQuote(runtimeRoot)} --package-lock --save-exact remotion@4 @remotion/cli@4 react@18.3.1 react-dom@18.3.1`,
    `${posixQuote(cliPath)} versions`,
    `${posixQuote(cliPath)} browser ensure`,
    `[ -e ${posixQuote(paths.join(projectDirectory, 'node_modules'))} ] || ln -s ${posixQuote(modulePath)} ${posixQuote(paths.join(projectDirectory, 'node_modules'))}`,
  ].join(' && ');
};

export const buildVideoRenderCommand = (options: Readonly<{
  cliPath: string;
  entry: string;
  compositionId: string;
  outputPath: string;
  quality: 'sample' | 'final';
  overwrite: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  platform: NodeJS.Platform;
}>): string => {
  const values = options.platform === 'win32' ? powershellQuote : posixQuote;
  const invoke = options.platform === 'win32' ? '& ' : '';
  const render = [
    `${invoke}${values(options.cliPath)}`,
    'render',
    values(options.entry),
    values(options.compositionId),
    values(options.outputPath),
    '--concurrency=1',
    `--public-dir=${values(platformPaths(options.platform).join(DEFAULT_PROJECT_DIRECTORY, 'public'))}`,
    '--log=verbose',
    `--overwrite=${String(options.overwrite)}`,
    ...(options.outputPath.toLowerCase().endsWith('.webm')
      ? ['--codec=vp9', '--audio-codec=opus']
      : []),
    ...(options.quality === 'sample'
      ? ['--frames=0-89', '--jpeg-quality=70']
      : ['--jpeg-quality=90']),
  ].join(' ');
  const probe = `${invoke}${values(options.ffprobePath)} -v error -show_streams -show_format -of json ${values(options.outputPath)}`;
  const flashScanner = `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const v=[...s.matchAll(/lavfi\\.signalstats\\.YAVG=([0-9.]+)/g)].map(m=>Number(m[1]));if(v.length===0){console.error('SugarCode flash scan received no frames');process.exit(3)}const f=[];for(let i=1;i<v.length-1;i++){if(Math.abs(v[i]-v[i-1])>=45&&Math.abs(v[i]-v[i+1])>=45&&Math.abs(v[i-1]-v[i+1])<=12)f.push(i)}console.log(JSON.stringify({sugarcodeFlashScan:{frames:v.length,isolatedLuminanceOutliers:f}}));if(f.length>0)process.exit(2)})`;
  const scan = `${invoke}${values(options.ffmpegPath)} -v error -i ${values(options.outputPath)} -vf ${values('signalstats,metadata=print:file=-')} -an -f null ${options.platform === 'win32' ? 'NUL' : '/dev/null'} | node -e ${values(flashScanner)}`;
  const makeDirectory = options.platform === 'win32'
    ? `New-Item -ItemType Directory -Force -Path ${values(outputDirectory(options.outputPath, options.platform))} | Out-Null`
    : `mkdir -p ${values(outputDirectory(options.outputPath, options.platform))}`;
  const separator = options.platform === 'win32'
    ? `; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; `
    : ' && ';
  return `${makeDirectory}${separator}${render}${separator}${scan}${separator}${probe}`;
};

export const buildVideoVoiceoverCommand = (options: Readonly<{
  scriptPath: string;
  outputPath: string;
  voice?: string;
  rate: number;
  overwrite: boolean;
  ffmpegPath: string;
  platform: NodeJS.Platform;
}>): string => {
  const temporaryPath = `${options.outputPath}.sugarcode-source.wav`;
  if (options.platform === 'win32') {
    const voiceSelection = options.voice
      ? `$synth.SelectVoice(${powershellQuote(options.voice)}); `
      : '';
    const overwriteGuard = options.overwrite
      ? ''
      : `if (Test-Path ${powershellQuote(options.outputPath)}) { throw 'Output already exists.' }; `;
    return `${overwriteGuard}New-Item -ItemType Directory -Force -Path ${powershellQuote(outputDirectory(options.outputPath, options.platform))} | Out-Null; Add-Type -AssemblyName System.Speech; $synth=New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voiceSelection}$synth.Rate=${Math.max(-10, Math.min(10, Math.round((options.rate - 180) / 18)))}; $synth.SetOutputToWaveFile(${powershellQuote(temporaryPath)}); $synth.Speak((Get-Content -Raw -LiteralPath ${powershellQuote(options.scriptPath)})); $synth.Dispose(); & ${powershellQuote(options.ffmpegPath)} ${options.overwrite ? '-y' : '-n'} -i ${powershellQuote(temporaryPath)} -ar 48000 -ac 2 ${powershellQuote(options.outputPath)}; $code=$LASTEXITCODE; Remove-Item -LiteralPath ${powershellQuote(temporaryPath)} -ErrorAction SilentlyContinue; exit $code`;
  }
  const renderSource = options.platform === 'darwin'
    ? [
        '/usr/bin/say',
        '-f',
        posixQuote(options.scriptPath),
        '-o',
        posixQuote(temporaryPath),
        '--rate',
        String(options.rate),
        ...(options.voice ? ['--voice', posixQuote(options.voice)] : []),
      ].join(' ')
    : [
        'espeak-ng',
        '-f',
        posixQuote(options.scriptPath),
        '-w',
        posixQuote(temporaryPath),
        '-s',
        String(options.rate),
        ...(options.voice ? ['-v', posixQuote(options.voice)] : []),
      ].join(' ');
  return [
    `mkdir -p ${posixQuote(outputDirectory(options.outputPath, options.platform))}`,
    options.overwrite ? 'true' : `[ ! -e ${posixQuote(options.outputPath)} ]`,
    renderSource,
    `${posixQuote(options.ffmpegPath)} ${options.overwrite ? '-y' : '-n'} -i ${posixQuote(temporaryPath)} -ar 48000 -ac 2 ${posixQuote(options.outputPath)}`,
    `rm -f ${posixQuote(temporaryPath)}`,
  ].join(' && ');
};

export const buildVideoAudioMixCommand = (options: Readonly<{
  videoPath: string;
  narrationPath?: string;
  musicPath?: string;
  outputPath: string;
  narrationVolume: number;
  musicVolume: number;
  overwrite: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  platform: NodeJS.Platform;
}>): string => {
  const quote = options.platform === 'win32' ? powershellQuote : posixQuote;
  const invoke = options.platform === 'win32' ? '& ' : '';
  const audioInputs = [options.narrationPath, options.musicPath].filter(
    (entry): entry is string => Boolean(entry),
  );
  const inputArguments = [options.videoPath, ...audioInputs]
    .map((path) => `-i ${quote(path)}`)
    .join(' ');
  let filter: string;
  if (options.narrationPath && options.musicPath) {
    filter = `[1:a]volume=${options.narrationVolume},loudnorm=I=-16:TP=-1.5:LRA=11,asplit=2[voice][side];[2:a]volume=${options.musicVolume}[music];[music][side]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=250[ducked];[voice][ducked]amix=inputs=2:duration=longest:dropout_transition=2,loudnorm=I=-16:TP=-1.5:LRA=11,apad[aout]`;
  } else if (options.narrationPath) {
    filter = `[1:a]volume=${options.narrationVolume},loudnorm=I=-16:TP=-1.5:LRA=11,apad[aout]`;
  } else {
    filter = `[1:a]volume=${options.musicVolume},loudnorm=I=-20:TP=-2:LRA=11,apad[aout]`;
  }
  const mix = `${invoke}${quote(options.ffmpegPath)} ${options.overwrite ? '-y' : '-n'} ${inputArguments} -filter_complex ${quote(filter)} -map 0:v:0 -map ${quote('[aout]')} -c:v copy -c:a aac -b:a 192k -shortest ${quote(options.outputPath)}`;
  const probe = `${invoke}${quote(options.ffprobePath)} -v error -show_streams -show_format -of json ${quote(options.outputPath)}`;
  const makeDirectory = options.platform === 'win32'
    ? `New-Item -ItemType Directory -Force -Path ${quote(outputDirectory(options.outputPath, options.platform))} | Out-Null`
    : `mkdir -p ${quote(outputDirectory(options.outputPath, options.platform))}`;
  const separator = options.platform === 'win32'
    ? `; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; `
    : ' && ';
  return `${makeDirectory}${separator}${mix}${separator}${probe}`;
};

const runCommand = async (
  options: VideoProductionToolOptions,
  command: string,
  approvalPurpose: string,
): Promise<unknown> => {
  const argumentsValue = {
    mode: 'fullAccess',
    command,
    arguments: [],
    cwd: '.',
    timeoutMs: MAX_RENDER_TIMEOUT_MS,
    approvalPurpose,
  } as const;
  return options.runPrivileged(
    'shell_exec',
    argumentsValue,
    (operationId) => executePrivilegedWorkspaceTool(
      options.nativeRuntime,
      operationId,
      options.workspaceId,
      'shell_exec',
      argumentsValue,
      options.onCommandOutput,
      options.threadId,
    ),
  );
};

const completedArtifact = (
  result: unknown,
  artifact: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => shellResultSucceeded(result)
  ? { ok: true, ...artifact }
  : { ok: false, error: 'commandFailed', commandResult: shellResultDetail(result) };

export const createVideoProductionTools = (
  options: VideoProductionToolOptions,
): readonly FunctionTool<Schema>[] => {
  const platform = options.platform ?? process.platform;
  const runtimeRoot = managedVideoRuntimeRoot(options.dataDirectory, platform);
  const cliPath = executablePath(runtimeRoot, platform);
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = ffprobeExecutable(options.ffmpegPath, platform);

  return [
    new FunctionTool({
      name: VIDEO_RUNTIME_PREPARE_TOOL_NAME,
      description:
        'Prepare SugarCode’s shared, version-locked Remotion 4 runtime and managed browser, then connect it to the workspace video source directory. This replaces project-local npm installation and is safe to call again: dependencies download only when the managed cache is missing.',
      parameters: prepareSchema,
      execute: async () => {
        const projectDirectory = DEFAULT_PROJECT_DIRECTORY;
        const wasReady = existsSync(cliPath);
        const result = await runCommand(
          options,
          buildVideoRuntimePrepareCommand(runtimeRoot, projectDirectory, platform),
          wasReady
            ? '连接 SugarCode 已缓存的视频运行环境，并确认渲染浏览器可用。'
            : '首次准备 SugarCode 视频运行环境：下载并锁定 Remotion 4 依赖及其渲染浏览器。',
        );
        return completedArtifact(result, {
          engine: 'remotion',
          majorVersion: 4,
          dependencyCache: wasReady ? 'reused' : 'installed',
          projectDirectory,
          concurrency: 1,
        });
      },
    }),
    new FunctionTool({
      name: VIDEO_RENDER_TOOL_NAME,
      description:
        'Render a Remotion composition with SugarCode’s managed runtime. Rendering always uses one browser worker to prevent intermittent capture flashes, then ffprobe verifies the resulting media. Call video_runtime_prepare first when requested by the result.',
      parameters: renderSchema,
      execute: async (input) => {
        if (!existsSync(cliPath)) {
          return {
            ok: false,
            error: 'videoRuntimeNotPrepared',
            message: 'Call video_runtime_prepare once before rendering.',
          };
        }
        const entry = safeVideoWorkspacePath(
          stringArgument(input, 'entry') ?? '',
          ['.tsx', '.ts', '.jsx', '.js'],
        );
        ensureEntryInProjectDirectory(entry, DEFAULT_PROJECT_DIRECTORY);
        const compositionId = stringArgument(input, 'compositionId') ?? '';
        if (compositionId.length > 128 || /[\r\n]/u.test(compositionId)) {
          throw new Error('compositionId is invalid.');
        }
        const outputPath = safeVideoWorkspacePath(
          stringArgument(input, 'outputPath') ?? '',
          ['.mp4', '.webm', '.mov'],
        );
        const quality = stringArgument(input, 'quality');
        if (quality !== 'sample' && quality !== 'final') {
          throw new Error('quality must be sample or final.');
        }
        const overwrite = booleanArgument(input, 'overwrite');
        const result = await runCommand(
          options,
          buildVideoRenderCommand({
            cliPath,
            entry,
            compositionId,
            outputPath,
            quality,
            overwrite,
            ffmpegPath,
            ffprobePath,
            platform,
          }),
          quality === 'sample'
            ? '渲染短样片并检查视频编码结果，不会安装项目依赖。'
            : '使用 SugarCode 托管运行环境单并发渲染最终视频，并检查编码结果。',
        );
        return completedArtifact(result, {
          artifact: { kind: 'video', path: outputPath },
          quality,
          concurrency: 1,
          verification: {
            ffprobe: true,
            fullDecode: true,
            isolatedLuminanceOutlierScan: true,
          },
          ...(quality === 'final'
            ? { finalDirective: `::preview{path="${outputPath}"}` }
            : {}),
        });
      },
    }),
    new FunctionTool({
      name: VIDEO_VOICEOVER_TOOL_NAME,
      description:
        'Create deterministic local narration from a reviewed workspace text file using the operating-system speech engine, then normalize it to a 48 kHz stereo WAV. No hosted API or credential is used.',
      parameters: voiceoverSchema,
      execute: async (input) => {
        const scriptPath = safeVideoWorkspacePath(
          stringArgument(input, 'scriptPath') ?? '',
          ['.txt', '.md'],
        );
        const outputPath = safeVideoWorkspacePath(
          stringArgument(input, 'outputPath') ?? '',
          ['.wav'],
        );
        const voice = stringArgument(input, 'voice', true);
        if (voice && (voice.length > 128 || /[\r\n]/u.test(voice))) {
          throw new Error('voice is invalid.');
        }
        const rate = Math.round(numberArgument(input, 'rate', 180, 80, 360));
        const overwrite = booleanArgument(input, 'overwrite');
        const result = await runCommand(
          options,
          buildVideoVoiceoverCommand({
            scriptPath,
            outputPath,
            voice,
            rate,
            overwrite,
            ffmpegPath,
            platform,
          }),
          '使用电脑本地语音引擎生成配音，并转换为视频制作所需的标准 WAV 音轨。',
        );
        return completedArtifact(result, {
          artifact: { kind: 'audio', path: outputPath },
          provider: platform === 'darwin'
            ? 'macos-say'
            : platform === 'win32'
              ? 'windows-system-speech'
              : 'espeak-ng',
          sampleRate: 48_000,
          channels: 2,
        });
      },
    }),
    new FunctionTool({
      name: VIDEO_AUDIO_MIX_TOOL_NAME,
      description:
        'Mix narration and/or background music into an existing workspace video using FFmpeg. Narration is loudness-normalized, music is reduced and automatically ducked under speech, and ffprobe verifies the final video with an audio stream.',
      parameters: mixSchema,
      execute: async (input) => {
        const videoPath = safeVideoWorkspacePath(
          stringArgument(input, 'videoPath') ?? '',
          ['.mp4', '.webm', '.mov'],
        );
        const narrationValue = stringArgument(input, 'narrationPath', true);
        const musicValue = stringArgument(input, 'musicPath', true);
        const narrationPath = narrationValue
          ? safeVideoWorkspacePath(narrationValue)
          : undefined;
        const musicPath = musicValue
          ? safeVideoWorkspacePath(musicValue)
          : undefined;
        if (!narrationPath && !musicPath) {
          throw new Error('Provide narrationPath, musicPath, or both.');
        }
        const outputPath = safeVideoWorkspacePath(
          stringArgument(input, 'outputPath') ?? '',
          ['.mp4', '.mov'],
        );
        if (outputPath === videoPath) {
          throw new Error('outputPath must differ from videoPath.');
        }
        const narrationVolume = numberArgument(input, 'narrationVolume', 1, 0, 4);
        const musicVolume = numberArgument(input, 'musicVolume', 0.18, 0, 1);
        const overwrite = booleanArgument(input, 'overwrite');
        const result = await runCommand(
          options,
          buildVideoAudioMixCommand({
            videoPath,
            narrationPath,
            musicPath,
            outputPath,
            narrationVolume,
            musicVolume,
            overwrite,
            ffmpegPath,
            ffprobePath,
            platform,
          }),
          '将本地配音和背景音乐混入视频，执行响度处理并检查最终音视频文件。',
        );
        return completedArtifact(result, {
          artifact: { kind: 'video', path: outputPath },
          audio: {
            narration: Boolean(narrationPath),
            music: Boolean(musicPath),
            ducking: Boolean(narrationPath && musicPath),
            codec: 'aac',
          },
          verification: { ffprobe: true, audioStreamRequired: true },
          finalDirective: `::preview{path="${outputPath}"}`,
        });
      },
    }),
  ];
};
