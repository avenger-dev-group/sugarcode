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

export const VIDEO_VOICE_PRESETS = ['female', 'male'] as const;
export type VideoVoicePreset = (typeof VIDEO_VOICE_PRESETS)[number];

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
      'Workspace-relative UTF-8 .txt or .md narration. Use either scriptPath for one continuous track or cueSheetPath for synchronized scene narration.',
    ),
    cueSheetPath: workspacePathProperty(
      'Optional workspace-relative JSON cue sheet. Shape: {fps?, leadInSeconds?, tailSeconds?, defaultGapSeconds?, cues:[{id,text,gapAfterSeconds?}]}. SugarCode measures every generated cue and writes a timing manifest beside outputPath.',
    ),
    outputPath: workspacePathProperty(
      'Workspace-relative .wav output path. Prefer assets/audio/<name>.wav.',
    ),
    voice: {
      type: Type.STRING,
      description:
        'Optional installed system voice name for advanced use. It overrides voicePreset when supplied.',
    },
    voicePreset: {
      type: Type.STRING,
      enum: [...VIDEO_VOICE_PRESETS],
      description:
        'Built-in local voice style. female is the default; male is the alternative. A concrete voice name overrides this preset.',
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
  required: ['outputPath'],
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
    timingPath: workspacePathProperty(
      'Optional timing manifest produced by synchronized video_voiceover. When supplied, mixing fails instead of truncating audio if the video, narration, and measured timeline drift apart.',
    ),
    maxDriftSeconds: {
      type: Type.NUMBER,
      description:
        'Maximum synchronization drift allowed before mixing, from 0.03 through 2 seconds. Defaults to 0.1 and is never less than two video frames.',
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

const enumArgument = <Value extends string>(
  input: unknown,
  name: string,
  values: readonly Value[],
  fallback: Value,
): Value => {
  if (!isRecord(input) || input[name] === undefined) return fallback;
  const value = input[name];
  if (typeof value !== 'string' || !values.includes(value as Value)) {
    throw new Error(`${name} must be ${values.join(' or ')}.`);
  }
  return value as Value;
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

const shellStructuredOutput = (
  result: unknown,
  property: string,
): Readonly<Record<string, unknown>> | undefined => {
  if (!isRecord(result) || !isRecord(result.output) || typeof result.output.stdout !== 'string') {
    return undefined;
  }
  for (const line of result.output.stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed) && isRecord(parsed[property])) return parsed[property];
    } catch {
      // Other command output is expected; only SugarCode's structured line is relevant.
    }
  }
  return undefined;
};

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
  voicePreset?: VideoVoicePreset;
  rate: number;
  overwrite: boolean;
  ffmpegPath: string;
  platform: NodeJS.Platform;
}>): string => {
  const temporaryPath = `${options.outputPath}.sugarcode-source.${options.platform === 'darwin' ? 'aiff' : 'wav'}`;
  if (options.platform === 'win32') {
    const voiceSelection = options.voice
      ? `$synth.SelectVoice(${powershellQuote(options.voice)}); `
      : `$gender=[System.Speech.Synthesis.VoiceGender]::${options.voicePreset === 'male' ? 'Male' : 'Female'}; try { $synth.SelectVoiceByHints($gender) } catch {}; `;
    const overwriteGuard = options.overwrite
      ? ''
      : `if (Test-Path ${powershellQuote(options.outputPath)}) { throw 'Output already exists.' }; `;
    return `${overwriteGuard}New-Item -ItemType Directory -Force -Path ${powershellQuote(outputDirectory(options.outputPath, options.platform))} | Out-Null; Add-Type -AssemblyName System.Speech; $synth=New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voiceSelection}$synth.Rate=${Math.max(-10, Math.min(10, Math.round((options.rate - 180) / 18)))}; $synth.SetOutputToWaveFile(${powershellQuote(temporaryPath)}); $synth.Speak((Get-Content -Raw -LiteralPath ${powershellQuote(options.scriptPath)})); $synth.Dispose(); & ${powershellQuote(options.ffmpegPath)} ${options.overwrite ? '-y' : '-n'} -i ${powershellQuote(temporaryPath)} -ar 48000 -ac 2 ${powershellQuote(options.outputPath)}; $code=$LASTEXITCODE; Remove-Item -LiteralPath ${powershellQuote(temporaryPath)} -ErrorAction SilentlyContinue; exit $code`;
  }
  const presetVoice = options.voice ?? (options.voicePreset === 'male'
    ? options.platform === 'darwin' ? 'Reed (中文（中国大陆）)' : 'zh+m3'
    : options.platform === 'darwin' ? 'Tingting' : 'zh+f3');
  const macRender = [
        '/usr/bin/say',
        '-f',
        posixQuote(options.scriptPath),
        '-o',
        posixQuote(temporaryPath),
        '--rate',
        String(options.rate),
        '--voice',
        posixQuote(presetVoice),
      ].join(' ');
  const renderSource = options.platform === 'darwin'
    ? options.voice
      ? macRender
      : `if /usr/bin/say -v '?' | grep -Fq ${posixQuote(presetVoice)}; then ${macRender}; else /usr/bin/say -f ${posixQuote(options.scriptPath)} -o ${posixQuote(temporaryPath)} --rate ${options.rate}; fi`
    : [
        'espeak-ng',
        '-f',
        posixQuote(options.scriptPath),
        '-w',
        posixQuote(temporaryPath),
        '-s',
        String(options.rate),
        '-v',
        posixQuote(presetVoice),
      ].join(' ');
  return [
    `mkdir -p ${posixQuote(outputDirectory(options.outputPath, options.platform))}`,
    options.overwrite ? 'true' : `[ ! -e ${posixQuote(options.outputPath)} ]`,
    renderSource,
    `${posixQuote(options.ffmpegPath)} ${options.overwrite ? '-y' : '-n'} -i ${posixQuote(temporaryPath)} -ar 48000 -ac 2 ${posixQuote(options.outputPath)}`,
    `rm -f ${posixQuote(temporaryPath)}`,
  ].join(' && ');
};

const cueVoiceoverNodeScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [sheetPath, outputPath, timingPath, platform, voicePreset, requestedVoice, rateValue, overwriteValue, ffmpeg, ffprobe] = process.argv.slice(1);
const overwrite = overwriteValue === 'true';
const rate = Number(rateValue);
const fail = (message) => { throw new Error(message); };
const run = (command, args, capture = false) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) fail((result.stderr || result.stdout || result.error?.message || command + ' failed').trim());
  return capture ? result.stdout : '';
};
const finite = (value, fallback, minimum, maximum, name) => {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) fail(name + ' is invalid.');
  return result;
};
const probeDuration = (file) => {
  const text = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file], true).trim();
  const duration = Number(text);
  if (!Number.isFinite(duration) || duration <= 0) fail('Could not measure narration duration for ' + path.basename(file) + '.');
  return duration;
};
const psQuote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const sheet = JSON.parse(fs.readFileSync(sheetPath, 'utf8'));
if (!sheet || typeof sheet !== 'object' || !Array.isArray(sheet.cues) || sheet.cues.length < 1 || sheet.cues.length > 240) fail('cueSheetPath must contain 1 through 240 cues.');
const fps = finite(sheet.fps, 30, 1, 120, 'fps');
if (!Number.isInteger(fps)) fail('fps must be an integer.');
const leadIn = finite(sheet.leadInSeconds, 0.3, 0, 60, 'leadInSeconds');
const tail = finite(sheet.tailSeconds, 0.5, 0, 60, 'tailSeconds');
const defaultGap = finite(sheet.defaultGapSeconds, 0.25, 0, 30, 'defaultGapSeconds');
const ids = new Set();
const cues = sheet.cues.map((cue, index) => {
  if (!cue || typeof cue !== 'object') fail('Cue ' + (index + 1) + ' is invalid.');
  const id = String(cue.id || '').trim();
  const text = String(cue.text || '').trim();
  if (!id || id.length > 128 || /[\u0000-\u001f]/u.test(id) || ids.has(id)) fail('Cue ids must be unique, non-empty strings of at most 128 characters.');
  if (!text || text.length > 8000) fail('Cue ' + id + ' text must contain 1 through 8000 characters.');
  ids.add(id);
  return { id, text, gapAfterSeconds: finite(cue.gapAfterSeconds, defaultGap, 0, 30, 'gapAfterSeconds') };
});
if (!overwrite && (fs.existsSync(outputPath) || fs.existsSync(timingPath))) fail('Output or timing manifest already exists.');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.mkdirSync(path.dirname(timingPath), { recursive: true });
const temporary = fs.mkdtempSync(path.join(path.dirname(outputPath), '.sugarcode-cued-voice-'));
const buildingOutput = outputPath + '.sugarcode-building.wav';
const buildingTiming = timingPath + '.sugarcode-building.json';
let resolvedVoice = requestedVoice || '';
try {
  if (!requestedVoice && platform === 'darwin') {
    const preferred = voicePreset === 'male' ? 'Reed (中文（中国大陆）)' : 'Tingting';
    const available = run('/usr/bin/say', ['-v', '?'], true).split(/\r?\n/u).some((line) => line.startsWith(preferred + ' '));
    resolvedVoice = available ? preferred : '';
  } else if (!requestedVoice && platform === 'linux') {
    resolvedVoice = voicePreset === 'male' ? 'zh+m3' : 'zh+f3';
  }
  const rendered = [];
  let cursorSeconds = 0;
  let cursorFrames = 0;
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const textPath = path.join(temporary, String(index).padStart(4, '0') + '.txt');
    const rawPath = path.join(temporary, String(index).padStart(4, '0') + (platform === 'darwin' ? '.aiff' : '.raw.wav'));
    const normalizedPath = path.join(temporary, String(index).padStart(4, '0') + '.wav');
    const paddedPath = path.join(temporary, String(index).padStart(4, '0') + '.padded.wav');
    fs.writeFileSync(textPath, cue.text, 'utf8');
    if (platform === 'darwin') {
      const args = ['-f', textPath, '-o', rawPath, '--rate', String(rate)];
      if (resolvedVoice) args.push('--voice', resolvedVoice);
      run('/usr/bin/say', args);
    } else if (platform === 'win32') {
      const selection = requestedVoice
        ? '$synth.SelectVoice(' + psQuote(requestedVoice) + ');'
        : '$gender=[System.Speech.Synthesis.VoiceGender]::' + (voicePreset === 'male' ? 'Male' : 'Female') + ';try{$synth.SelectVoiceByHints($gender)}catch{};';
      const speech = 'Add-Type -AssemblyName System.Speech;$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer;' + selection + '$synth.Rate=' + Math.max(-10, Math.min(10, Math.round((rate - 180) / 18))) + ';$synth.SetOutputToWaveFile(' + psQuote(rawPath) + ');$synth.Speak((Get-Content -Raw -Encoding UTF8 -LiteralPath ' + psQuote(textPath) + '));$synth.Dispose();';
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', speech]);
    } else {
      const args = ['-f', textPath, '-w', rawPath, '-s', String(rate)];
      if (resolvedVoice) args.push('-v', resolvedVoice);
      run('espeak-ng', args);
    }
    run(ffmpeg, ['-y', '-v', 'error', '-i', rawPath, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', normalizedPath]);
    const voiceDuration = probeDuration(normalizedPath);
    const before = index === 0 ? leadIn : 0;
    const after = cue.gapAfterSeconds + (index === cues.length - 1 ? tail : 0);
    const paddedDuration = before + voiceDuration + after;
    run(ffmpeg, ['-y', '-v', 'error', '-i', normalizedPath, '-af', 'adelay=' + Math.round(before * 1000) + ':all=1,apad', '-t', paddedDuration.toFixed(6), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', paddedPath]);
    const nextSeconds = cursorSeconds + paddedDuration;
    const nextFrames = Math.max(cursorFrames + 1, Math.round(nextSeconds * fps));
    rendered.push({
      id: cue.id,
      text: cue.text,
      sceneStartSeconds: cursorSeconds,
      voiceStartSeconds: cursorSeconds + before,
      voiceEndSeconds: cursorSeconds + before + voiceDuration,
      sceneEndSeconds: nextSeconds,
      startFrame: cursorFrames,
      endFrame: nextFrames,
      durationInFrames: nextFrames - cursorFrames,
      measuredVoiceDurationSeconds: voiceDuration,
      gapAfterSeconds: after,
      file: paddedPath,
    });
    cursorSeconds = nextSeconds;
    cursorFrames = nextFrames;
  }
  const concatPath = path.join(temporary, 'concat.txt');
  fs.writeFileSync(concatPath, rendered.map((cue) => "file '" + cue.file.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'").join('\n') + '\n', 'utf8');
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concatPath, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', buildingOutput]);
  const totalDurationSeconds = probeDuration(buildingOutput);
  const totalDurationInFrames = Math.max(1, Math.round(totalDurationSeconds * fps));
  const lastCue = rendered.at(-1);
  if (lastCue) {
    lastCue.sceneEndSeconds = totalDurationSeconds;
    lastCue.endFrame = totalDurationInFrames;
    lastCue.durationInFrames = totalDurationInFrames - lastCue.startFrame;
  }
  const manifest = {
    version: 1,
    source: 'measured-system-voice',
    fps,
    voicePreset,
    resolvedVoice: resolvedVoice || 'system-default',
    sampleRate: 48000,
    channels: 2,
    totalDurationSeconds,
    totalDurationInFrames,
    cues: rendered.map(({ file, ...cue }) => cue),
  };
  fs.writeFileSync(buildingTiming, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  if (overwrite) {
    fs.rmSync(outputPath, { force: true });
    fs.rmSync(timingPath, { force: true });
  }
  fs.renameSync(buildingOutput, outputPath);
  fs.renameSync(buildingTiming, timingPath);
  process.stdout.write(JSON.stringify({ sugarcodeVoiceTiming: { totalDurationSeconds, totalDurationInFrames: manifest.totalDurationInFrames, cueCount: rendered.length, fps, resolvedVoice: manifest.resolvedVoice } }) + '\n');
} finally {
  fs.rmSync(buildingOutput, { force: true });
  fs.rmSync(buildingTiming, { force: true });
  fs.rmSync(temporary, { recursive: true, force: true });
}
`;

export const buildCuedVideoVoiceoverCommand = (options: Readonly<{
  cueSheetPath: string;
  outputPath: string;
  timingPath: string;
  voice?: string;
  voicePreset: VideoVoicePreset;
  rate: number;
  overwrite: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  platform: NodeJS.Platform;
}>): string => {
  const quote = options.platform === 'win32' ? powershellQuote : posixQuote;
  return [
    'node',
    '-e',
    quote(cueVoiceoverNodeScript),
    quote(options.cueSheetPath),
    quote(options.outputPath),
    quote(options.timingPath),
    quote(options.platform),
    quote(options.voicePreset),
    quote(options.voice ?? ''),
    String(options.rate),
    String(options.overwrite),
    quote(options.ffmpegPath),
    quote(options.ffprobePath),
  ].join(' ');
};

const synchronizationCheckNodeScript = String.raw`
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const [timingPath, videoPath, narrationPath, maxDriftValue, ffprobe] = process.argv.slice(1);
const probeDuration = (file) => {
  const result = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error((result.stderr || result.error?.message || 'ffprobe failed').trim());
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not measure ' + file + '.');
  return duration;
};
const probeFrameRate = (file) => {
  const result = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'default=nk=1:nw=1', file], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error((result.stderr || result.error?.message || 'ffprobe failed').trim());
  const [numerator, denominator = '1'] = result.stdout.trim().split('/');
  const frameRate = Number(numerator) / Number(denominator);
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error('Could not measure video frame rate.');
  return frameRate;
};
const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
const expected = Number(timing.totalDurationSeconds);
const fps = Number(timing.fps);
if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(fps) || fps <= 0) throw new Error('The narration timing manifest is invalid.');
const allowed = Math.max(Number(maxDriftValue), 2 / fps);
const video = probeDuration(videoPath);
const videoFps = probeFrameRate(videoPath);
const narration = probeDuration(narrationPath);
const videoDrift = Math.abs(video - expected);
const narrationDrift = Math.abs(narration - expected);
const fpsMatches = Math.abs(videoFps - fps) <= 0.01;
const result = { expectedDurationSeconds: expected, videoDurationSeconds: video, narrationDurationSeconds: narration, videoDriftSeconds: videoDrift, narrationDriftSeconds: narrationDrift, allowedDriftSeconds: allowed, timelineFps: fps, videoFps, fpsMatches };
process.stdout.write(JSON.stringify({ sugarcodeSynchronizationCheck: result }) + '\n');
if (!fpsMatches || videoDrift > allowed || narrationDrift > allowed) {
  process.stderr.write('Audio/video synchronization check failed. Rebuild the composition from the measured timing manifest before mixing.\n');
  process.exit(2);
}
`;

export const buildVideoSynchronizationCheckCommand = (options: Readonly<{
  timingPath: string;
  videoPath: string;
  narrationPath: string;
  maxDriftSeconds: number;
  ffprobePath: string;
  platform: NodeJS.Platform;
}>): string => {
  const quote = options.platform === 'win32' ? powershellQuote : posixQuote;
  return [
    'node',
    '-e',
    quote(synchronizationCheckNodeScript),
    quote(options.timingPath),
    quote(options.videoPath),
    quote(options.narrationPath),
    String(options.maxDriftSeconds),
    quote(options.ffprobePath),
  ].join(' ');
};

export const buildVideoAudioMixCommand = (options: Readonly<{
  videoPath: string;
  narrationPath?: string;
  musicPath?: string;
  outputPath: string;
  narrationVolume: number;
  musicVolume: number;
  timingPath?: string;
  maxDriftSeconds?: number;
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
  const synchronizationCheck = options.timingPath && options.narrationPath
    ? `${buildVideoSynchronizationCheckCommand({
        timingPath: options.timingPath,
        videoPath: options.videoPath,
        narrationPath: options.narrationPath,
        maxDriftSeconds: options.maxDriftSeconds ?? 0.1,
        ffprobePath: options.ffprobePath,
        platform: options.platform,
      })}${separator}`
    : '';
  return `${makeDirectory}${separator}${synchronizationCheck}${mix}${separator}${probe}`;
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
        'Create local narration with the operating-system speech engine and normalize it to a 48 kHz stereo WAV. female and male are built-in presets. For multi-scene or long videos, pass a JSON cueSheetPath: one call generates every cue plus a measured frame-accurate timing manifest that must drive the composition. No hosted API or credential is used.',
      parameters: voiceoverSchema,
      execute: async (input) => {
        const scriptValue = stringArgument(input, 'scriptPath', true);
        const cueSheetValue = stringArgument(input, 'cueSheetPath', true);
        if (Boolean(scriptValue) === Boolean(cueSheetValue)) {
          throw new Error('Provide exactly one of scriptPath or cueSheetPath.');
        }
        const scriptPath = scriptValue
          ? safeVideoWorkspacePath(scriptValue, ['.txt', '.md'])
          : undefined;
        const cueSheetPath = cueSheetValue
          ? safeVideoWorkspacePath(cueSheetValue, ['.json'])
          : undefined;
        const outputPath = safeVideoWorkspacePath(
          stringArgument(input, 'outputPath') ?? '',
          ['.wav'],
        );
        const timingPath = cueSheetPath
          ? safeVideoWorkspacePath(`${outputPath.slice(0, -4)}.timing.json`, ['.json'])
          : undefined;
        const voice = stringArgument(input, 'voice', true);
        if (voice && (voice.length > 128 || /[\r\n]/u.test(voice))) {
          throw new Error('voice is invalid.');
        }
        const voicePreset = enumArgument(
          input,
          'voicePreset',
          VIDEO_VOICE_PRESETS,
          'female',
        );
        const rate = Math.round(numberArgument(input, 'rate', 180, 80, 360));
        const overwrite = booleanArgument(input, 'overwrite');
        const result = await runCommand(
          options,
          cueSheetPath && timingPath
            ? buildCuedVideoVoiceoverCommand({
                cueSheetPath,
                outputPath,
                timingPath,
                voice,
                voicePreset,
                rate,
                overwrite,
                ffmpegPath,
                ffprobePath,
                platform,
              })
            : buildVideoVoiceoverCommand({
                scriptPath: scriptPath ?? '',
                outputPath,
                voice,
                voicePreset,
                rate,
                overwrite,
                ffmpegPath,
                platform,
              }),
          cueSheetPath
            ? '使用电脑本地语音引擎一次生成分段配音，并按每段真实时长创建画面同步清单。'
            : '使用电脑本地语音引擎生成配音，并转换为视频制作所需的标准 WAV 音轨。',
        );
        const measuredTiming = shellStructuredOutput(result, 'sugarcodeVoiceTiming');
        return completedArtifact(result, {
          artifact: { kind: 'audio', path: outputPath },
          provider: platform === 'darwin'
            ? 'macos-say'
            : platform === 'win32'
              ? 'windows-system-speech'
              : 'espeak-ng',
          voicePreset,
          sampleRate: 48_000,
          channels: 2,
          ...(timingPath
            ? {
                timing: {
                  source: 'measuredAudio',
                  path: timingPath,
                  ...(measuredTiming ?? {}),
                },
              }
            : {
                timing: {
                  source: 'continuousTrack',
                  synchronizedScenes: false,
                },
              }),
        });
      },
    }),
    new FunctionTool({
      name: VIDEO_AUDIO_MIX_TOOL_NAME,
      description:
        'Mix narration and/or background music into an existing workspace video using FFmpeg. Pass the measured timingPath for synchronized narration; mixing then aborts if video duration, video fps, or narration duration differs from the cue timeline. Narration is loudness-normalized, music is reduced and ducked under speech, and ffprobe verifies the final video with an audio stream.',
      parameters: mixSchema,
      execute: async (input) => {
        const videoPath = safeVideoWorkspacePath(
          stringArgument(input, 'videoPath') ?? '',
          ['.mp4', '.webm', '.mov'],
        );
        const narrationValue = stringArgument(input, 'narrationPath', true);
        const musicValue = stringArgument(input, 'musicPath', true);
        const timingValue = stringArgument(input, 'timingPath', true);
        const narrationPath = narrationValue
          ? safeVideoWorkspacePath(narrationValue)
          : undefined;
        const musicPath = musicValue
          ? safeVideoWorkspacePath(musicValue)
          : undefined;
        const timingPath = timingValue
          ? safeVideoWorkspacePath(timingValue, ['.json'])
          : undefined;
        if (!narrationPath && !musicPath) {
          throw new Error('Provide narrationPath, musicPath, or both.');
        }
        if (timingPath && !narrationPath) {
          throw new Error('timingPath requires narrationPath.');
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
        const maxDriftSeconds = numberArgument(input, 'maxDriftSeconds', 0.1, 0.03, 2);
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
            timingPath,
            maxDriftSeconds,
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
          verification: {
            ffprobe: true,
            audioStreamRequired: true,
            synchronization: timingPath ? 'measuredTimelineRequired' : 'notRequested',
            ...(timingPath ? { maxDriftSeconds } : {}),
          },
          finalDirective: `::preview{path="${outputPath}"}`,
        });
      },
    }),
  ];
};
