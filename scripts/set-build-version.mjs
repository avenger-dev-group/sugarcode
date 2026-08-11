import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const validateVersion = (version) => {
  if (!version || !semverPattern.test(version)) {
    throw new Error(
      'Version must be SemVer without a leading v, for example 3.0.1 or 3.1.0-beta.1.',
    );
  }

  const prerelease = version.split('+', 1)[0].split('-').slice(1).join('-');
  if (
    prerelease
      .split('.')
      .some(
        (identifier) =>
          /^\d+$/.test(identifier) &&
          identifier.length > 1 &&
          identifier.startsWith('0'),
      )
  ) {
    throw new Error(
      `Version contains a numeric prerelease identifier with a leading zero: ${version}.`,
    );
  }
};

const parseSemver = (version) => {
  const [withoutBuild] = version.split('+', 1);
  const separator = withoutBuild.indexOf('-');
  const core = separator < 0 ? withoutBuild : withoutBuild.slice(0, separator);
  const prerelease =
    separator < 0 ? [] : withoutBuild.slice(separator + 1).split('.');
  return { core: core.split('.').map(Number), prerelease };
};

const compareSemver = (leftVersion, rightVersion) => {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) {
      return 0;
    }
    return left.prerelease.length === 0 ? 1 : -1;
  }

  const identifierCount = Math.max(
    left.prerelease.length,
    right.prerelease.length,
  );
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return Number(leftIdentifier) < Number(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
};

const updateJsonVersion = async (workspaceRoot, relativePath, version) => {
  const filePath = path.join(workspaceRoot, relativePath);
  const manifest = JSON.parse(await readFile(filePath, 'utf8'));
  manifest.version = version;
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
};

const updateMatchedVersions = async (
  workspaceRoot,
  relativePath,
  pattern,
  version,
  label,
) => {
  const filePath = path.join(workspaceRoot, relativePath);
  const current = await readFile(filePath, 'utf8');
  let matchCount = 0;
  const next = current.replace(pattern, (_match, prefix, suffix) => {
    matchCount += 1;
    return `${prefix}${version}${suffix}`;
  });
  if (matchCount === 0) {
    throw new Error(`Could not find ${label} version in ${relativePath}.`);
  }
  await writeFile(filePath, next);
};

export const setBuildVersion = async (workspaceRoot, version) => {
  validateVersion(version);
  const currentRootManifest = JSON.parse(
    await readFile(path.join(workspaceRoot, 'package.json'), 'utf8'),
  );
  const currentDesktopManifest = JSON.parse(
    await readFile(
      path.join(workspaceRoot, 'apps', 'desktop', 'package.json'),
      'utf8',
    ),
  );
  validateVersion(currentRootManifest.version);
  validateVersion(currentDesktopManifest.version);
  const currentVersion =
    compareSemver(
      currentRootManifest.version,
      currentDesktopManifest.version,
    ) >= 0
      ? currentRootManifest.version
      : currentDesktopManifest.version;
  if (compareSemver(version, currentVersion) < 0) {
    throw new Error(
      `Version ${version} is older than the current project version ${currentVersion}.`,
    );
  }
  await updateJsonVersion(workspaceRoot, 'package.json', version);
  await updateJsonVersion(workspaceRoot, 'apps/desktop/package.json', version);
  await updateMatchedVersions(
    workspaceRoot,
    'Cargo.toml',
    /(\[workspace\.package\][\s\S]*?\nversion = ")[^"]+(")/,
    version,
    'Cargo workspace package',
  );
  await updateMatchedVersions(
    workspaceRoot,
    'Cargo.lock',
    /(\[\[package\]\]\nname = "sugarcode-[^"]+"\nversion = ")[^"]+(")/g,
    version,
    'SugarCode Cargo lock package',
  );
};

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const workspaceRoot = path.resolve(path.dirname(scriptPath), '..');
  const version = process.argv[2] ?? process.env.RELEASE_VERSION;
  await setBuildVersion(workspaceRoot, version);
  console.log(`Updated SugarCode build version to ${version}.`);
}
