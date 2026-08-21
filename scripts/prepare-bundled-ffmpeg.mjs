import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';

export const FFMPEG_VERSION = '9.0.1';
export const FFMPEG_SOURCE_URL =
  `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`;
export const FFMPEG_SOURCE_SHA256 =
  'cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635';

export const FFMPEG_CONFIGURE_ARGUMENTS = Object.freeze([
  '--disable-everything',
  '--disable-autodetect',
  '--disable-doc',
  '--disable-debug',
  '--disable-network',
  '--disable-ffplay',
  '--disable-ffprobe',
  '--disable-gpl',
  '--disable-nonfree',
  '--enable-ffmpeg',
  '--enable-protocol=file',
  '--enable-demuxer=mov,matroska,avi,mpegvideo,mpegts',
  '--enable-decoder=h264,hevc,vp8,vp9,av1,mpeg4,mpeg1video,mpeg2video,mjpeg,prores,vc1,theora,aac,mp3,opus,vorbis,flac,alac,ac3,eac3,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le',
  '--enable-parser=h264,hevc,vp8,vp9,av1,mpeg4video,mpegvideo,mjpeg,vc1',
  '--enable-filter=fps,scale,aresample',
  '--enable-encoder=mjpeg,pcm_s16le',
  '--enable-muxer=image2,wav,segment',
]);

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const outputDirectory = path.join(
  workspaceRoot,
  'apps',
  'desktop',
  'vendor',
  'ffmpeg',
);
const supportedTargets = new Set([
  'darwin:arm64',
  'darwin:x64',
  'win32:x64',
]);

export const bundledFfmpegName = (platform) =>
  platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

export const assertBundledFfmpegTarget = (platform, arch) => {
  const target = `${platform}:${arch}`;
  if (!supportedTargets.has(target)) {
    throw new Error(`Bundled FFmpeg does not support ${target}.`);
  }
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(
      `Bundled FFmpeg must be built on its target host; requested ${target}, current host is ${process.platform}:${process.arch}.`,
    );
  }
};

const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const verifySourceArchive = async (filePath) => {
  const actual = await sha256File(filePath);
  if (actual !== FFMPEG_SOURCE_SHA256) {
    throw new Error(
      `FFmpeg source checksum mismatch: expected ${FFMPEG_SOURCE_SHA256}, received ${actual}.`,
    );
  }
};

const downloadSourceArchive = async () => {
  const overridden = process.env.SUGARCODE_FFMPEG_SOURCE_ARCHIVE;
  if (overridden) {
    const resolved = path.resolve(overridden);
    await verifySourceArchive(resolved);
    return resolved;
  }

  const cacheDirectory = path.join(os.tmpdir(), 'sugarcode-ffmpeg-source');
  const archivePath = path.join(
    cacheDirectory,
    `ffmpeg-${FFMPEG_VERSION}.tar.xz`,
  );
  await mkdir(cacheDirectory, { recursive: true });
  if (existsSync(archivePath)) {
    await verifySourceArchive(archivePath);
    return archivePath;
  }

  const temporaryPath = `${archivePath}.${process.pid}.download`;
  const response = await fetch(FFMPEG_SOURCE_URL, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(
      `Unable to download FFmpeg source (${response.status} ${response.statusText}).`,
    );
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath));
  await verifySourceArchive(temporaryPath);
  await rename(temporaryPath, archivePath);
  return archivePath;
};

const run = (executable, arguments_, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      ...options,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let output = '';
    if (options.capture) {
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(
        new Error(
          signal
            ? `${executable} terminated by ${signal}.`
            : `${executable} exited with code ${code ?? 'unknown'}.`,
        ),
      );
    });
  });

const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

const buildSource = async (sourceDirectory, platform) => {
  const jobs = String(Math.max(1, Math.min(availableParallelism(), 8)));
  if (platform === 'win32') {
    const bashPath =
      process.env.SUGARCODE_MSYS2_BASH ?? 'C:\\msys64\\usr\\bin\\bash.exe';
    if (!existsSync(bashPath)) {
      throw new Error(
        'Windows FFmpeg packaging requires MSYS2 at C:\\msys64 or SUGARCODE_MSYS2_BASH.',
      );
    }
    const normalizedSource = sourceDirectory
      .replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`)
      .replaceAll('\\', '/');
    const command = [
      'export PATH=/mingw64/bin:/usr/bin:$PATH',
      `cd ${shellQuote(normalizedSource)}`,
      `./configure ${FFMPEG_CONFIGURE_ARGUMENTS.map(shellQuote).join(' ')}`,
      `make -j${jobs} ffmpeg`,
    ].join(' && ');
    await run(bashPath, ['-lc', command]);
    return;
  }

  await run('./configure', FFMPEG_CONFIGURE_ARGUMENTS, {
    cwd: sourceDirectory,
  });
  await run('make', [`-j${jobs}`, 'ffmpeg'], { cwd: sourceDirectory });
};

export const verifyBundledFfmpeg = async (binaryPath) => {
  const version = await run(binaryPath, ['-hide_banner', '-version'], {
    capture: true,
  });
  if (!version.includes(`ffmpeg version ${FFMPEG_VERSION}`)) {
    throw new Error(`Bundled FFmpeg is not version ${FFMPEG_VERSION}.`);
  }
  const buildConfiguration = await run(
    binaryPath,
    ['-hide_banner', '-buildconf'],
    { capture: true },
  );
  const normalizedConfiguration = buildConfiguration
    .replaceAll("'", '')
    .replaceAll('"', '');
  for (const requiredFlag of FFMPEG_CONFIGURE_ARGUMENTS) {
    if (!normalizedConfiguration.includes(requiredFlag)) {
      throw new Error(`Bundled FFmpeg is missing ${requiredFlag}.`);
    }
  }
  for (const forbiddenFlag of ['--enable-gpl', '--enable-nonfree']) {
    if (normalizedConfiguration.includes(forbiddenFlag)) {
      throw new Error(`Bundled FFmpeg contains forbidden flag ${forbiddenFlag}.`);
    }
  }
};

const buildMetadata = () => `SugarCode bundled FFmpeg\n\nVersion: ${FFMPEG_VERSION}\nSource: ${FFMPEG_SOURCE_URL}\nSource SHA-256: ${FFMPEG_SOURCE_SHA256}\nLicense: GNU Lesser General Public License version 2.1 or later\nSugarCode patches: none\n\nConfigure arguments:\n${FFMPEG_CONFIGURE_ARGUMENTS.join(' ')}\n`;

export const prepareBundledFfmpeg = async ({ platform, arch }) => {
  assertBundledFfmpegTarget(platform, arch);
  const binaryName = bundledFfmpegName(platform);
  const binaryPath = path.join(outputDirectory, binaryName);
  if (
    existsSync(binaryPath) &&
    existsSync(path.join(outputDirectory, 'COPYING.LGPLv2.1')) &&
    existsSync(path.join(outputDirectory, 'FFMPEG-BUILD.txt'))
  ) {
    try {
      await verifyBundledFfmpeg(binaryPath);
      console.log(`Reusing bundled FFmpeg ${FFMPEG_VERSION} for ${platform}/${arch}.`);
      return binaryPath;
    } catch {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }

  const archivePath = await downloadSourceArchive();
  const buildDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'sugarcode-ffmpeg-build-'),
  );
  try {
    await run('tar', ['-xf', archivePath, '-C', buildDirectory]);
    const sourceDirectory = path.join(
      buildDirectory,
      `ffmpeg-${FFMPEG_VERSION}`,
    );
    await buildSource(sourceDirectory, platform);
    const builtBinary = path.join(sourceDirectory, binaryName);
    await verifyBundledFfmpeg(builtBinary);

    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });
    await copyFile(builtBinary, binaryPath);
    if (platform !== 'win32') {
      await chmod(binaryPath, 0o755);
    }
    await copyFile(
      path.join(sourceDirectory, 'COPYING.LGPLv2.1'),
      path.join(outputDirectory, 'COPYING.LGPLv2.1'),
    );
    await writeFile(
      path.join(outputDirectory, 'FFMPEG-BUILD.txt'),
      buildMetadata(),
      'utf8',
    );
    console.log(`Prepared bundled FFmpeg ${FFMPEG_VERSION} for ${platform}/${arch}.`);
    return binaryPath;
  } finally {
    await rm(buildDirectory, { recursive: true, force: true });
  }
};

export const stageFfmpegSource = async (destinationDirectory) => {
  const archivePath = await downloadSourceArchive();
  await mkdir(destinationDirectory, { recursive: true });
  const fileName = `ffmpeg-${FFMPEG_VERSION}.tar.xz`;
  await copyFile(archivePath, path.join(destinationDirectory, fileName));
  await writeFile(
    path.join(destinationDirectory, `${fileName}.sha256`),
    `${FFMPEG_SOURCE_SHA256}  ${fileName}\n`,
    'utf8',
  );
};

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  const arguments_ = process.argv.slice(2);
  const sourceOnlyIndex = arguments_.indexOf('--source-only');
  if (sourceOnlyIndex >= 0) {
    const destination = arguments_[sourceOnlyIndex + 1];
    if (!destination) {
      throw new Error('--source-only requires a destination directory.');
    }
    await stageFfmpegSource(path.resolve(destination));
  } else {
    const platformIndex = arguments_.indexOf('--platform');
    const archIndex = arguments_.indexOf('--arch');
    await prepareBundledFfmpeg({
      platform: platformIndex >= 0 ? arguments_[platformIndex + 1] : process.platform,
      arch: archIndex >= 0 ? arguments_[archIndex + 1] : process.arch,
    });
  }
}
