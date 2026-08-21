import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { extractFile, listPackage } = require('@electron/asar');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const [platform, arch] = process.argv.slice(2);
const supportedTargets = new Set([
  'darwin:arm64',
  'darwin:x64',
  'win32:x64',
]);
const target = `${platform}:${arch}`;

if (!supportedTargets.has(target)) {
  throw new Error(`Unsupported Desktop verification target: ${target}.`);
}
if (process.platform !== platform || process.arch !== arch) {
  throw new Error(
    `Packaged Desktop verification must run on its target host; requested ${target}, current host is ${process.platform}:${process.arch}.`,
  );
}

const packageDirectory = path.join(
  workspaceRoot,
  'apps',
  'desktop',
  'out',
  `SugarCode-${platform}-${arch}`,
);
const applicationRoot =
  platform === 'darwin'
    ? path.join(packageDirectory, 'SugarCode.app', 'Contents')
    : packageDirectory;
const resourcesDirectory = path.join(
  applicationRoot,
  platform === 'darwin' ? 'Resources' : 'resources',
);
const executablePath =
  platform === 'darwin'
    ? path.join(applicationRoot, 'MacOS', 'SugarCode')
    : path.join(applicationRoot, 'SugarCode.exe');
const asarPath = path.join(resourcesDirectory, 'app.asar');
const nativeModulePath = path.join(
  resourcesDirectory,
  'sugarcode-desktop-native.node',
);
const ffmpegPath = path.join(
  resourcesDirectory,
  'ffmpeg',
  platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
);

for (const requiredPath of [
  executablePath,
  asarPath,
  nativeModulePath,
  ffmpegPath,
  path.join(resourcesDirectory, 'ffmpeg', 'COPYING.LGPLv2.1'),
  path.join(resourcesDirectory, 'ffmpeg', 'FFMPEG-BUILD.txt'),
  path.join(resourcesDirectory, 'icon.png'),
  path.join(resourcesDirectory, 'THIRD_PARTY_NOTICES.txt'),
]) {
  if (!existsSync(requiredPath)) {
    throw new Error(`Packaged Desktop payload is missing ${requiredPath}.`);
  }
}

const fuseWire = await getCurrentFuseWire(executablePath);
const cookieEncryptionState =
  fuseWire[FuseV1Options.EnableCookieEncryption];
// Fuse wire states are stored as ASCII `0` (disabled) and `1` (enabled).
if (cookieEncryptionState !== '0'.charCodeAt(0)) {
  throw new Error(
    'Packaged Desktop must keep Electron cookie encryption disabled to avoid macOS Safe Storage access.',
  );
}

// @electron/asar builds its listing paths with the host path module, so Windows
// returns backslash-separated entries while macOS returns POSIX paths.
const asarEntries = listPackage(asarPath).map((entry) =>
  entry.replaceAll(path.win32.sep, path.posix.sep),
);
for (const requiredEntry of [
  '/.vite/build/main.js',
  '/.vite/build/preload.js',
  '/.vite/build/runtime.mjs',
  '/.vite/renderer/main_window/index.html',
  '/package.json',
]) {
  if (!asarEntries.includes(requiredEntry)) {
    throw new Error(`app.asar is missing ${requiredEntry}.`);
  }
}

const forbiddenEntry = asarEntries.find((entry) =>
  /(^|\/)(node_modules|scripts|src|sugarcode-app-server|sugarcode-cli|sugarcode-sidecar|target)(\/|$)/.test(
    entry,
  ),
);
if (forbiddenEntry) {
  throw new Error(`app.asar contains forbidden payload ${forbiddenEntry}.`);
}

const sourceManifest = JSON.parse(
  readFileSync(path.join(workspaceRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
);
const packagedManifest = JSON.parse(extractFile(asarPath, 'package.json'));
if (packagedManifest.version !== sourceManifest.version) {
  throw new Error(
    `Packaged version ${packagedManifest.version} does not match source version ${sourceManifest.version}.`,
  );
}

const expectedMachine = {
  'darwin:arm64': 0x0100000c,
  'darwin:x64': 0x01000007,
  'win32:x64': 0x8664,
}[target];

const readMachine = (filePath) => {
  const header = readFileSync(filePath).subarray(0, 4096);
  if (platform === 'darwin') {
    if (header.readUInt32LE(0) !== 0xfeedfacf) {
      throw new Error(`${filePath} is not a thin 64-bit Mach-O binary.`);
    }
    return header.readUInt32LE(4);
  }

  if (header.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${filePath} is not a PE binary.`);
  }
  const peOffset = header.readUInt32LE(0x3c);
  if (peOffset + 6 > header.length) {
    throw new Error(`${filePath} has an invalid PE header offset.`);
  }
  if (header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`${filePath} has an invalid PE signature.`);
  }
  return header.readUInt16LE(peOffset + 4);
};

for (const binaryPath of [executablePath, nativeModulePath, ffmpegPath]) {
  const machine = readMachine(binaryPath);
  if (machine !== expectedMachine) {
    throw new Error(
      `${binaryPath} has machine 0x${machine.toString(16)}, expected 0x${expectedMachine.toString(16)}.`,
    );
  }
}

const ffmpegVersion = execFileSync(
  ffmpegPath,
  ['-hide_banner', '-version'],
  { encoding: 'utf8' },
);
if (
  !ffmpegVersion.includes('ffmpeg version 9.0.1') ||
  !ffmpegVersion.includes('--disable-gpl') ||
  !ffmpegVersion.includes('--disable-nonfree') ||
  ffmpegVersion.includes('--enable-gpl') ||
  ffmpegVersion.includes('--enable-nonfree')
) {
  throw new Error('Packaged FFmpeg version or license configuration is invalid.');
}

console.log(
  `Verified SugarCode ${sourceManifest.version} package for ${platform}/${arch} (${asarEntries.length} ASAR entries).`,
);
