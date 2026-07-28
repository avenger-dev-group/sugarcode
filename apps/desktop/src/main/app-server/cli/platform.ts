export type ExpectedCliPlatform = Readonly<{
  family: 'unix' | 'windows';
  os: 'linux' | 'macos' | 'windows';
  arch: 'aarch64' | 'x86_64';
}>;

export type CliTarget = Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  arch: 'arm64' | 'x64';
  rustTriple: string;
  executableName: 'sugarcode' | 'sugarcode.exe';
  expectedPlatform: ExpectedCliPlatform;
}>;

const TARGETS: Readonly<Record<string, CliTarget>> = {
  'darwin/arm64': {
    platform: 'darwin',
    arch: 'arm64',
    rustTriple: 'aarch64-apple-darwin',
    executableName: 'sugarcode',
    expectedPlatform: {
      family: 'unix',
      os: 'macos',
      arch: 'aarch64',
    },
  },
  'darwin/x64': {
    platform: 'darwin',
    arch: 'x64',
    rustTriple: 'x86_64-apple-darwin',
    executableName: 'sugarcode',
    expectedPlatform: {
      family: 'unix',
      os: 'macos',
      arch: 'x86_64',
    },
  },
  'linux/arm64': {
    platform: 'linux',
    arch: 'arm64',
    rustTriple: 'aarch64-unknown-linux-gnu',
    executableName: 'sugarcode',
    expectedPlatform: {
      family: 'unix',
      os: 'linux',
      arch: 'aarch64',
    },
  },
  'linux/x64': {
    platform: 'linux',
    arch: 'x64',
    rustTriple: 'x86_64-unknown-linux-gnu',
    executableName: 'sugarcode',
    expectedPlatform: {
      family: 'unix',
      os: 'linux',
      arch: 'x86_64',
    },
  },
  'win32/arm64': {
    platform: 'win32',
    arch: 'arm64',
    rustTriple: 'aarch64-pc-windows-msvc',
    executableName: 'sugarcode.exe',
    expectedPlatform: {
      family: 'windows',
      os: 'windows',
      arch: 'aarch64',
    },
  },
  'win32/x64': {
    platform: 'win32',
    arch: 'x64',
    rustTriple: 'x86_64-pc-windows-msvc',
    executableName: 'sugarcode.exe',
    expectedPlatform: {
      family: 'windows',
      os: 'windows',
      arch: 'x86_64',
    },
  },
};

export const getCliTarget = (
  platform: string,
  arch: string,
): CliTarget | null => TARGETS[`${platform}/${arch}`] ?? null;

export const requireNativeCliTarget = (
  platform: string,
  arch: string,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): CliTarget => {
  const target = getCliTarget(platform, arch);
  if (!target) {
    throw new Error(`Unsupported packaged CLI target: ${platform}/${arch}.`);
  }
  if (platform !== hostPlatform || arch !== hostArch) {
    throw new Error(
      `Cross-target packaged CLI builds are unsupported: requested ${platform}/${arch}, host ${hostPlatform}/${hostArch}.`,
    );
  }
  return target;
};
