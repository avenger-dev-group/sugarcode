import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MAX_EXTRACTED_FRAMES = 64;
const MAX_EXTRACTED_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_CHUNKS = 16;
const MAX_AUDIO_CHUNK_BYTES = 9 * 1024 * 1024;
const MAX_EXTRACTED_AUDIO_BYTES = 128 * 1024 * 1024;
const AUDIO_CHUNK_SECONDS = 4 * 60;
const MAX_FFMPEG_DIAGNOSTIC_BYTES = 64 * 1024;

export type ExtractedVideoFrames = Readonly<{
  durationSeconds?: number;
  effectiveFps: number;
  frames: readonly Readonly<{
    data: string;
    timestampSeconds: number;
  }>[];
}>;

export type ExtractedAudioChunk = Readonly<{
  data: string;
  mediaType: 'audio/wav';
  startSeconds: number;
}>;

export type ExtractedVideoAudio = Readonly<{
  durationSeconds?: number;
  chunks: readonly ExtractedAudioChunk[];
}>;

const ffmpegOutput = async (
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  acceptFailure = false,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      signal,
    });
    let diagnostic = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (Buffer.byteLength(diagnostic, 'utf8') < MAX_FFMPEG_DIAGNOSTIC_BYTES) {
        diagnostic += String(chunk);
        if (Buffer.byteLength(diagnostic, 'utf8') > MAX_FFMPEG_DIAGNOSTIC_BYTES) {
          diagnostic = Buffer.from(diagnostic, 'utf8')
            .subarray(0, MAX_FFMPEG_DIAGNOSTIC_BYTES)
            .toString('utf8');
        }
      }
    });
    child.once('error', reject);
    child.once('exit', (code, exitSignal) => {
      if (code === 0 || acceptFailure) {
        resolve(diagnostic);
        return;
      }
      reject(new Error(
        exitSignal
          ? `Video media extraction was terminated by ${exitSignal}.`
          : `Video media extraction failed (${code ?? 'unknown'}): ${diagnostic.trim().slice(-512)}`,
      ));
    });
  });

const durationFromDiagnostic = (value: string): number | undefined => {
  const match = /Duration:\s*(\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)/u.exec(value);
  if (!match) {
    return undefined;
  }
  const seconds =
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
};

const requireExecutable = (executable: string | undefined): string => {
  if (!executable) {
    throw new Error(
      'Video fallback analysis requires the bundled FFmpeg media helper, but it is unavailable.',
    );
  }
  return executable;
};

export const extractVideoFrames = async (
  executable: string | undefined,
  filePath: string,
  requestedFps: number,
  signal: AbortSignal,
): Promise<ExtractedVideoFrames> => {
  const ffmpeg = requireExecutable(executable);
  const probe = await ffmpegOutput(
    ffmpeg,
    ['-hide_banner', '-i', filePath],
    signal,
    true,
  );
  const durationSeconds = durationFromDiagnostic(probe);
  const requestedFrames = durationSeconds === undefined
    ? Math.min(MAX_EXTRACTED_FRAMES, 32)
    : Math.max(1, Math.ceil(durationSeconds * requestedFps));
  const frameCount = Math.min(MAX_EXTRACTED_FRAMES, requestedFrames);
  const effectiveFps = durationSeconds === undefined
    ? Math.min(requestedFps, 1)
    : Math.min(requestedFps, frameCount / durationSeconds);
  const directory = await mkdtemp(path.join(tmpdir(), 'sugarcode-video-frames-'));
  try {
    await ffmpegOutput(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        filePath,
        '-vf',
        `fps=${effectiveFps},scale=1280:1280:force_original_aspect_ratio=decrease`,
        '-frames:v',
        String(frameCount),
        '-q:v',
        '4',
        path.join(directory, 'frame-%03d.jpg'),
      ],
      signal,
    );
    const names = (await readdir(directory))
      .filter((name) => /^frame-\d{3}\.jpg$/u.test(name))
      .sort();
    const frames: Array<{ data: string; timestampSeconds: number }> = [];
    let totalBytes = 0;
    for (const [index, name] of names.entries()) {
      const bytes = await readFile(path.join(directory, name));
      if (totalBytes + bytes.length > MAX_EXTRACTED_FRAME_BYTES) {
        break;
      }
      totalBytes += bytes.length;
      frames.push({
        data: bytes.toString('base64'),
        timestampSeconds: effectiveFps > 0 ? index / effectiveFps : index,
      });
    }
    if (frames.length === 0) {
      throw new Error('FFmpeg did not produce any usable video frames.');
    }
    return {
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      effectiveFps,
      frames,
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((): undefined => undefined);
  }
};

export const extractVideoAudio = async (
  executable: string | undefined,
  filePath: string,
  signal: AbortSignal,
): Promise<ExtractedVideoAudio> => {
  const ffmpeg = requireExecutable(executable);
  const probe = await ffmpegOutput(
    ffmpeg,
    ['-hide_banner', '-i', filePath],
    signal,
    true,
  );
  const durationSeconds = durationFromDiagnostic(probe);
  if (!/Stream #.*Audio:/u.test(probe)) {
    return {
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      chunks: [],
    };
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'sugarcode-video-audio-'));
  try {
    await ffmpegOutput(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        filePath,
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-codec:a',
        'pcm_s16le',
        '-f',
        'segment',
        '-segment_time',
        String(AUDIO_CHUNK_SECONDS),
        '-segment_format',
        'wav',
        '-reset_timestamps',
        '1',
        path.join(directory, 'audio-%03d.wav'),
      ],
      signal,
    );
    const names = (await readdir(directory))
      .filter((name) => /^audio-\d{3}\.wav$/u.test(name))
      .sort()
      .slice(0, MAX_AUDIO_CHUNKS);
    const chunks: ExtractedAudioChunk[] = [];
    let totalBytes = 0;
    for (const [index, name] of names.entries()) {
      const bytes = await readFile(path.join(directory, name));
      if (
        bytes.length > MAX_AUDIO_CHUNK_BYTES ||
        totalBytes + bytes.length > MAX_EXTRACTED_AUDIO_BYTES
      ) {
        break;
      }
      totalBytes += bytes.length;
      chunks.push({
        data: bytes.toString('base64'),
        mediaType: 'audio/wav',
        startSeconds: index * AUDIO_CHUNK_SECONDS,
      });
    }
    return {
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      chunks,
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((): undefined => undefined);
  }
};
