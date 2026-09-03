import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildVideoAudioMixCommand,
  buildVideoRenderCommand,
  buildVideoRuntimePrepareCommand,
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
  assert.match(command, /--voice 'Tingting'/u);
  assert.match(command, /-ar 48000 -ac 2/u);
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
  assert.ok(mix.startsWith("New-Item -ItemType Directory -Force -Path 'renders' | Out-Null"));
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
