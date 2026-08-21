import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  FFMPEG_SOURCE_SHA256,
  FFMPEG_VERSION,
} from './prepare-bundled-ffmpeg.mjs';

const run = promisify(execFile);
const arguments_ = process.argv.slice(2);
const downloadOnly = arguments_.includes('--download-only');
const unknownOptions = arguments_.filter(
  (argument) =>
    argument.startsWith('--') && argument !== '--download-only',
);
const versionArgument = arguments_.find(
  (argument) => !argument.startsWith('--'),
);
const version = versionArgument?.replace(/^v/u, '');
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

if (!version || !semverPattern.test(version) || unknownOptions.length > 0) {
  throw new Error(
    'Usage: pnpm release:gitcode:local <version> [--download-only]',
  );
}
if (!downloadOnly && !process.env.GITCODE_TOKEN) {
  throw new Error(
    'GITCODE_TOKEN is required unless --download-only is used.',
  );
}

const tag = `v${version}`;
const githubRepository =
  process.env.GITHUB_REPOSITORY ?? 'avenger-dev-group/sugarcode';
const repositoryParts = githubRepository.split('/');
if (
  repositoryParts.length !== 2 ||
  repositoryParts.some((part) => part.length === 0)
) {
  throw new Error('GITHUB_REPOSITORY must use the owner/repository format.');
}

const downloadsRoot = path.resolve(
  process.env.RELEASE_DOWNLOADS_DIR ?? 'release-assets',
);
const assetsDirectory = path.join(downloadsRoot, tag);
const expectedNames = [
  `SugarCode-${version}-macos-arm64.dmg`,
  `SugarCode-${version}-macos-x64.dmg`,
  `SugarCode-${version}-windows-x64-Setup.exe`,
  'update-manifest.json',
  `ffmpeg-${FFMPEG_VERSION}.tar.xz`,
  `ffmpeg-${FFMPEG_VERSION}.tar.xz.sha256`,
];

const gh = async (...arguments__) => {
  try {
    return await run('gh', arguments__, {
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        'GitHub CLI is required. Install it from https://cli.github.com/ and run `gh auth login`.',
      );
    }
    throw error;
  }
};

const sha256 = async (filePath) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};

const { stdout: releaseJson } = await gh(
  'release',
  'view',
  tag,
  '--repo',
  githubRepository,
  '--json',
  'body,assets',
);
const release = JSON.parse(releaseJson);
const assetsByName = new Map(
  (release.assets ?? []).map((asset) => [asset.name, asset]),
);
const missingAssets = expectedNames.filter((name) => !assetsByName.has(name));
if (missingAssets.length > 0) {
  throw new Error(
    `GitHub Release ${tag} is missing assets: ${missingAssets.join(', ')}`,
  );
}

await mkdir(assetsDirectory, { recursive: true });
const downloadArguments = [
  'release',
  'download',
  tag,
  '--repo',
  githubRepository,
  '--dir',
  assetsDirectory,
  '--clobber',
];
for (const name of expectedNames) {
  downloadArguments.push('--pattern', name);
}
console.log(`Downloading GitHub Release ${tag} from ${githubRepository}...`);
await gh(...downloadArguments);

for (const name of expectedNames) {
  const metadata = await stat(path.join(assetsDirectory, name));
  const expectedSize = assetsByName.get(name)?.size;
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Downloaded asset is empty: ${name}`);
  }
  if (expectedSize && metadata.size !== expectedSize) {
    throw new Error(
      `Downloaded ${name} has size ${metadata.size}; expected ${expectedSize}.`,
    );
  }
  console.log(`Downloaded ${name} (${metadata.size} bytes).`);
}

const manifest = JSON.parse(
  await readFile(path.join(assetsDirectory, 'update-manifest.json'), 'utf8'),
);
if (manifest.schemaVersion !== 1 || manifest.version !== version) {
  throw new Error(
    `Update manifest does not describe release version ${version}.`,
  );
}

const expectedPlatforms = {
  'darwin-arm64': expectedNames[0],
  'darwin-x64': expectedNames[1],
  'win32-x64': expectedNames[2],
};
for (const [platform, file] of Object.entries(expectedPlatforms)) {
  const entry = manifest.platforms?.[platform];
  const metadata = await stat(path.join(assetsDirectory, file));
  if (
    entry?.file !== file ||
    entry.size !== metadata.size ||
    typeof entry.sha256 !== 'string'
  ) {
    throw new Error(`Update manifest has an invalid ${platform} entry.`);
  }
  const actualHash = await sha256(path.join(assetsDirectory, file));
  if (actualHash !== entry.sha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${file}.`);
  }
  console.log(`Verified ${file}.`);
}

const ffmpegSourceName = `ffmpeg-${FFMPEG_VERSION}.tar.xz`;
const ffmpegSourceHash = await sha256(
  path.join(assetsDirectory, ffmpegSourceName),
);
const ffmpegChecksum = await readFile(
  path.join(assetsDirectory, `${ffmpegSourceName}.sha256`),
  'utf8',
);
if (
  ffmpegSourceHash !== FFMPEG_SOURCE_SHA256 ||
  ffmpegChecksum.trim() !== `${FFMPEG_SOURCE_SHA256}  ${ffmpegSourceName}`
) {
  throw new Error('FFmpeg corresponding source archive failed SHA-256 verification.');
}

console.log(`GitHub Release ${tag} is available in ${assetsDirectory}.`);
if (downloadOnly) {
  console.log('Download-only mode completed; GitCode was not changed.');
} else {
  const releaseNotes = manifest.notes?.trim() || release.body?.trim();
  if (!releaseNotes) {
    throw new Error(
      `GitHub Release ${tag} and its manifest do not contain release notes.`,
    );
  }

  process.env.RELEASE_VERSION = version;
  process.env.RELEASE_NOTES = releaseNotes;
  process.env.RELEASE_ASSETS_DIR = assetsDirectory;
  await import('./publish-gitcode-release.mjs');
}
