import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const release = process.argv.includes('--release');
const profile = release ? 'release' : 'debug';
const cargoArguments = [
  'build',
  '--locked',
  '-p',
  'sugarcode-desktop-native',
  ...(release ? ['--release'] : []),
];
const build = spawnSync('cargo', cargoArguments, {
  cwd: workspaceRoot,
  stdio: 'inherit',
  shell: false,
});
if (build.error) {
  throw build.error;
}
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const artifactName =
  process.platform === 'win32'
    ? 'sugarcode_desktop_native.dll'
    : process.platform === 'darwin'
      ? 'libsugarcode_desktop_native.dylib'
      : 'libsugarcode_desktop_native.so';
const source = path.join(workspaceRoot, 'target', profile, artifactName);
const nativeDirectory = path.join(workspaceRoot, 'apps', 'desktop', 'native');
mkdirSync(nativeDirectory, { recursive: true });
copyFileSync(
  source,
  path.join(nativeDirectory, 'sugarcode-desktop-native.node'),
);
