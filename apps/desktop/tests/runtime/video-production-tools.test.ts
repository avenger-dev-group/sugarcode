import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildCuedVideoVoiceoverCommand,
  buildVideoAudioMixCommand,
  buildVideoRenderCommand,
  buildVideoRuntimePrepareCommand,
  buildVideoSynchronizationCheckCommand,
  buildVideoVoiceoverCommand,
  createVideoProductionTools,
  managedVideoRuntimeRoot,
  safeVideoWorkspacePath,
} from '../../src/runtime/tools/video-production.ts';
import type { NativeRuntimeBinding } from '../../src/runtime/persistence/native.ts';

test('managed video runtime lives under app data instead of the project', () => {
  const dataDirectory = join(tmpdir(), 'sugarcode-data');
  const root = managedVideoRuntimeRoot(dataDirectory);

  assert.equal(root, join(dataDirectory, 'video-runtime', 'remotion-v4'));
});

for (const platform of ['darwin', 'linux', 'win32'] as const) {
  test(`managed video runtime respects the ${platform} target platform`, () => {
    const dataDirectory = platform === 'win32'
      ? String.raw`C:\Users\Sugar Code\data`
      : '/tmp/sugarcode data';
    const expected = platform === 'win32'
      ? String.raw`C:\Users\Sugar Code\data\video-runtime\remotion-v4`
      : '/tmp/sugarcode data/video-runtime/remotion-v4';

    assert.equal(managedVideoRuntimeRoot(dataDirectory, platform), expected);
  });
}

test('runtime exposes separate prepare, render, voiceover, and mix tools', async () => {
  const calls: Readonly<Record<string, unknown>>[] = [];
  const tools = createVideoProductionTools({
    nativeRuntime: {} as NativeRuntimeBinding,
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    dataDirectory: '/definitely-missing/sugarcode-video-runtime-test',
    platform: 'darwin',
    runPrivileged: async (_toolName, argumentsValue) => {
      calls.push(argumentsValue);
      return {
        status: 'completed',
        output: { outcome: { type: 'exitCode', code: 0 } },
      };
    },
  });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'video_runtime_prepare',
      'video_render',
      'video_voiceover',
      'video_audio_mix',
    ],
  );
  const prepare = tools[0];
  assert.ok(prepare);
  const result = await prepare.runAsync({
    args: {},
    toolContext: {} as never,
  });
  assert.deepEqual(result, {
    ok: true,
    engine: 'remotion',
    majorVersion: 4,
    dependencyCache: 'installed',
    projectDirectory: '.sugarcode/video',
    concurrency: 1,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.mode, 'fullAccess');
  assert.ok(String(calls[0]?.command).includes(
    "'/definitely-missing/sugarcode-video-runtime-test/video-runtime/remotion-v4/node_modules/.bin/remotion' versions",
  ));
});

test('cued narration returns measured timing and defaults to the female preset', async () => {
  const calls: Readonly<Record<string, unknown>>[] = [];
  const tools = createVideoProductionTools({
    nativeRuntime: {} as NativeRuntimeBinding,
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    dataDirectory: '/tmp/sugarcode-video-runtime-test',
    platform: 'darwin',
    runPrivileged: async (_toolName, argumentsValue) => {
      calls.push(argumentsValue);
      return {
        status: 'completed',
        output: {
          stdout: '{"sugarcodeVoiceTiming":{"totalDurationSeconds":12.5,"totalDurationInFrames":375,"cueCount":3,"fps":30,"resolvedVoice":"Tingting"}}\n',
          outcome: { type: 'exitCode', code: 0 },
        },
      };
    },
  });
  const voiceover = tools.find((tool) => tool.name === 'video_voiceover');
  assert.ok(voiceover);
  const result = await voiceover.runAsync({
    args: {
      cueSheetPath: 'assets/audio/cues.json',
      outputPath: 'assets/audio/narration.wav',
    },
    toolContext: {} as never,
  }) as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(result.voicePreset, 'female');
  assert.deepEqual(result.timing, {
    source: 'measuredAudio',
    path: 'assets/audio/narration.timing.json',
    totalDurationSeconds: 12.5,
    totalDurationInFrames: 375,
    cueCount: 3,
    fps: 30,
    resolvedVoice: 'Tingting',
  });
  assert.match(String(calls[0]?.command), /assets\/audio\/cues\.json/u);
  assert.match(String(calls[0]?.command), /assets\/audio\/narration\.timing\.json/u);
  await assert.rejects(
    voiceover.runAsync({
      args: {
        scriptPath: 'assets/audio/script.txt',
        cueSheetPath: 'assets/audio/cues.json',
        outputPath: 'assets/audio/narration.wav',
      },
      toolContext: {} as never,
    }),
    /exactly one/u,
  );
});

test('video paths stay workspace-relative and extension constrained', () => {
  assert.equal(
    safeVideoWorkspacePath('./renders/demo.mp4', ['.mp4']),
    'renders/demo.mp4',
  );
  assert.throws(
    () => safeVideoWorkspacePath('../outside.mp4', ['.mp4']),
    /workspace-relative/u,
  );
  assert.throws(
    () => safeVideoWorkspacePath('renders/demo.txt', ['.mp4']),
    /Path must end/u,
  );
});

test('runtime preparation installs once into managed cache and links source dependencies', () => {
  const command = buildVideoRuntimePrepareCommand(
    '/tmp/sugarcode data/video-runtime/remotion-v4',
    '.sugarcode/video',
    'darwin',
  );

  assert.match(command, /npm install --prefix/u);
  assert.match(command, /--save-exact remotion@4 @remotion\/cli@4/u);
  assert.match(command, /remotion' versions/u);
  assert.match(command, /remotion' browser ensure/u);
  assert.match(command, /\.sugarcode\/video\/node_modules/u);
  assert.doesNotMatch(command, /npm install --save-exact remotion@4/u);
});

test('Windows runtime preparation uses Windows paths regardless of the host', () => {
  const root = String.raw`C:\Users\Sugar Code\video-runtime\remotion-v4`;
  const command = buildVideoRuntimePrepareCommand(root, '.sugarcode/video', 'win32');

  assert.ok(command.includes(`$modules='${root}\\node_modules'`));
  assert.ok(command.includes(`& '${root}\\node_modules\\.bin\\remotion.cmd' versions`));
  assert.ok(command.includes(`& '${root}\\node_modules\\.bin\\remotion.cmd' browser ensure`));
  assert.match(command, /New-Item -ItemType Junction/u);
});

test('render command fixes concurrency, scans decoded frames, and probes output', () => {
  const command = buildVideoRenderCommand({
    cliPath: '/tmp/runtime/remotion',
    entry: '.sugarcode/video/index.tsx',
    compositionId: 'Demo',
    outputPath: 'renders/demo.mp4',
    quality: 'final',
    overwrite: false,
    ffmpegPath: '/opt/bin/ffmpeg',
    ffprobePath: '/opt/bin/ffprobe',
    platform: 'darwin',
  });

  assert.match(command, /--concurrency=1/u);
  assert.match(command, /--public-dir='\.sugarcode\/video\/public'/u);
  assert.match(command, /--overwrite=false/u);
  assert.match(command, /signalstats,metadata=print:file=-/u);
  assert.match(command, /isolatedLuminanceOutliers/u);
  assert.match(command, /ffprobe.*-show_streams -show_format/u);
});

test('Windows rendering uses target paths for public assets and output directories', () => {
  const command = buildVideoRenderCommand({
    cliPath: String.raw`C:\Sugar Code\runtime\remotion.cmd`,
    entry: '.sugarcode/video/index.tsx',
    compositionId: 'Demo',
    outputPath: String.raw`renders\demo.mp4`,
    quality: 'final',
    overwrite: false,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    platform: 'win32',
  });

  assert.ok(command.includes(String.raw`--public-dir='.sugarcode\video\public'`));
  assert.ok(command.startsWith("New-Item -ItemType Directory -Force -Path 'renders' | Out-Null"));
  assert.ok(command.includes(String.raw`& 'C:\Sugar Code\runtime\remotion.cmd' render`));
  assert.match(command, /-f null NUL/u);
});

test('webm renders select a compatible video and audio codec', () => {
  const command = buildVideoRenderCommand({
    cliPath: '/tmp/runtime/remotion',
    entry: '.sugarcode/video/index.tsx',
    compositionId: 'Demo',
    outputPath: 'renders/demo.webm',
    quality: 'sample',
    overwrite: false,
    ffmpegPath: '/opt/bin/ffmpeg',
    ffprobePath: '/opt/bin/ffprobe',
    platform: 'linux',
  });

  assert.match(command, /--codec=vp9 --audio-codec=opus/u);
  assert.match(command, /--frames=0-89/u);
});

test('local voiceover reads a script file and emits normalized wav audio', () => {
  const command = buildVideoVoiceoverCommand({
    scriptPath: 'assets/audio/narration.txt',
    outputPath: 'assets/audio/narration.wav',
    voice: 'Tingting',
    rate: 190,
    overwrite: false,
    ffmpegPath: '/opt/bin/ffmpeg',
    platform: 'darwin',
  });

  assert.match(command, /\/usr\/bin\/say/u);
  assert.match(command, /-f 'assets\/audio\/narration\.txt'/u);
  assert.match(command, /-o 'assets\/audio\/narration\.wav\.sugarcode-source\.aiff'/u);
  assert.match(command, /--voice 'Tingting'/u);
  assert.match(command, /-ar 48000 -ac 2/u);
});

test('local voiceover exposes stable female and male presets without voice discovery', () => {
  const female = buildVideoVoiceoverCommand({
    scriptPath: 'assets/audio/narration.txt',
    outputPath: 'assets/audio/female.wav',
    voicePreset: 'female',
    rate: 180,
    overwrite: false,
    ffmpegPath: '/opt/bin/ffmpeg',
    platform: 'darwin',
  });
  const male = buildVideoVoiceoverCommand({
    scriptPath: 'assets/audio/narration.txt',
    outputPath: 'assets/audio/male.wav',
    voicePreset: 'male',
    rate: 180,
    overwrite: false,
    ffmpegPath: '/opt/bin/ffmpeg',
    platform: 'darwin',
  });
  const windowsFemale = buildVideoVoiceoverCommand({
    scriptPath: String.raw`assets\audio\narration.txt`,
    outputPath: String.raw`assets\audio\female.wav`,
    voicePreset: 'female',
    rate: 180,
    overwrite: false,
    ffmpegPath: 'ffmpeg',
    platform: 'win32',
  });

  assert.match(female, /Tingting/u);
  assert.match(male, /Reed \(中文（中国大陆）\)/u);
  assert.match(windowsFemale, /VoiceGender\]::Female/u);
});

test('cued voiceover creates one measured timing manifest in a single command', () => {
  const command = buildCuedVideoVoiceoverCommand({
    cueSheetPath: 'assets/audio/cues.json',
    outputPath: 'assets/audio/narration.wav',
    timingPath: 'assets/audio/narration.timing.json',
    voicePreset: 'female',
    rate: 180,
    overwrite: false,
    ffmpegPath: '/opt/bin/ffmpeg',
    ffprobePath: '/opt/bin/ffprobe',
    platform: 'darwin',
  });

  assert.match(command, /^node -e /u);
  assert.match(command, /assets\/audio\/cues\.json/u);
  assert.match(command, /assets\/audio\/narration\.timing\.json/u);
  assert.match(command, /sugarcodeVoiceTiming/u);
  assert.match(command, /durationInFrames/u);
});

test('Windows voiceover and mixing create the target output directories', () => {
  const voiceover = buildVideoVoiceoverCommand({
    scriptPath: String.raw`assets\audio\narration.txt`,
    outputPath: String.raw`assets\audio\narration.wav`,
    rate: 190,
    overwrite: false,
    ffmpegPath: 'ffmpeg',
    platform: 'win32',
  });
  const mix = buildVideoAudioMixCommand({
    videoPath: String.raw`renders\silent.mp4`,
    narrationPath: String.raw`assets\audio\narration.wav`,
    outputPath: String.raw`renders\final.mp4`,
    narrationVolume: 1,
    musicVolume: 0.18,
    overwrite: false,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    platform: 'win32',
  });

  assert.ok(voiceover.includes("New-Item -ItemType Directory -Force -Path 'assets/audio' | Out-Null"));
  assert.ok(voiceover.includes(String.raw`SetOutputToWaveFile('assets\audio\narration.wav.sugarcode-source.wav')`));
  assert.ok(!voiceover.includes('.sugarcode-source.aiff'));
  assert.ok(mix.startsWith("New-Item -ItemType Directory -Force -Path 'renders' | Out-Null"));
});

test('Linux voiceover keeps the native espeak WAV source format', () => {
  const command = buildVideoVoiceoverCommand({
    scriptPath: 'assets/audio/narration.txt',
    outputPath: 'assets/audio/narration.wav',
    rate: 190,
    overwrite: false,
    ffmpegPath: '/usr/bin/ffmpeg',
    platform: 'linux',
  });

  assert.match(command, /espeak-ng/u);
  assert.match(command, /-w 'assets\/audio\/narration\.wav\.sugarcode-source\.wav'/u);
  assert.doesNotMatch(command, /\.sugarcode-source\.aiff/u);
});

test('audio mix normalizes narration and ducks music under speech', () => {
  const command = buildVideoAudioMixCommand({
    videoPath: 'renders/silent.mp4',
    narrationPath: 'assets/audio/narration.wav',
    musicPath: 'assets/audio/music.wav',
    outputPath: 'renders/final.mp4',
    narrationVolume: 1,
    musicVolume: 0.18,
    overwrite: false,
    ffmpegPath: '/opt/bin/ffmpeg',
    ffprobePath: '/opt/bin/ffprobe',
    platform: 'darwin',
  });

  assert.match(command, /loudnorm=I=-16/u);
  assert.match(command, /asplit=2\[voice\]\[side\]/u);
  assert.match(command, /sidechaincompress/u);
  assert.match(command, /-c:v copy -c:a aac/u);
  assert.match(command, /ffprobe.*-show_streams -show_format/u);
});

test('audio mix rejects measured timeline drift before shortening narration', () => {
  const check = buildVideoSynchronizationCheckCommand({
    timingPath: 'assets/audio/narration.timing.json',
    videoPath: 'renders/silent.mp4',
    narrationPath: 'assets/audio/narration.wav',
    maxDriftSeconds: 0.1,
    ffprobePath: '/opt/bin/ffprobe',
    platform: 'darwin',
  });
  const mix = buildVideoAudioMixCommand({
    videoPath: 'renders/silent.mp4',
    narrationPath: 'assets/audio/narration.wav',
    timingPath: 'assets/audio/narration.timing.json',
    outputPath: 'renders/final.mp4',
    narrationVolume: 1,
    musicVolume: 0.18,
    overwrite: false,
    ffmpegPath: '/opt/bin/ffmpeg',
    ffprobePath: '/opt/bin/ffprobe',
    platform: 'darwin',
  });

  assert.match(check, /sugarcodeSynchronizationCheck/u);
  assert.match(check, /2 \/ fps/u);
  assert.ok(mix.indexOf('sugarcodeSynchronizationCheck') < mix.indexOf("'/opt/bin/ffmpeg' -n"));
  assert.match(mix, /Rebuild the composition from the measured timing manifest/u);
});
