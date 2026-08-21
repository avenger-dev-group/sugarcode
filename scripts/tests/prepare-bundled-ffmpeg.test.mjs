import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FFMPEG_CONFIGURE_ARGUMENTS,
  FFMPEG_SOURCE_SHA256,
  FFMPEG_VERSION,
  assertBundledFfmpegTarget,
  bundledFfmpegName,
} from '../prepare-bundled-ffmpeg.mjs';

test('bundled FFmpeg build is pinned and excludes GPL and nonfree components', () => {
  assert.equal(FFMPEG_VERSION, '9.0.1');
  assert.match(FFMPEG_SOURCE_SHA256, /^[a-f0-9]{64}$/u);
  assert.ok(FFMPEG_CONFIGURE_ARGUMENTS.includes('--disable-gpl'));
  assert.ok(FFMPEG_CONFIGURE_ARGUMENTS.includes('--disable-nonfree'));
  assert.ok(!FFMPEG_CONFIGURE_ARGUMENTS.includes('--enable-gpl'));
  assert.ok(!FFMPEG_CONFIGURE_ARGUMENTS.includes('--enable-nonfree'));
  assert.ok(FFMPEG_CONFIGURE_ARGUMENTS.includes('--disable-network'));
  assert.ok(
    FFMPEG_CONFIGURE_ARGUMENTS.some((argument) =>
      argument.includes('--enable-decoder=') && argument.includes('aac'),
    ),
  );
  assert.ok(
    FFMPEG_CONFIGURE_ARGUMENTS.includes('--enable-encoder=mjpeg,pcm_s16le'),
  );
  assert.ok(
    FFMPEG_CONFIGURE_ARGUMENTS.includes('--enable-muxer=image2,wav,segment'),
  );
  assert.ok(
    FFMPEG_CONFIGURE_ARGUMENTS.includes('--enable-filter=fps,scale,aresample'),
  );
});

test('bundled FFmpeg names match packaged platform conventions', () => {
  assert.equal(bundledFfmpegName('darwin'), 'ffmpeg');
  assert.equal(bundledFfmpegName('win32'), 'ffmpeg.exe');
  assert.throws(
    () => assertBundledFfmpegTarget('linux', 'x64'),
    /does not support linux:x64/u,
  );
});
