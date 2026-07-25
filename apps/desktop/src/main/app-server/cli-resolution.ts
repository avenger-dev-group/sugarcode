import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

export type ResolvedCli = Readonly<{
  executablePath: string;
  workingDirectory: string;
}>;

export type CliResolutionErrorCode =
  | 'development-cli-missing'
  | 'development-cli-not-executable'
  | 'packaged-cli-missing'
  | 'packaged-cli-not-executable';

export class CliResolutionError extends Error {
  readonly code: CliResolutionErrorCode;

  constructor(code: CliResolutionErrorCode, message: string) {
    super(message);
    this.name = 'CliResolutionError';
    this.code = code;
  }
}

const assertRepositoryRoot = async (repositoryRoot: string): Promise<void> => {
  try {
    const [cargoManifest, packageManifest] = await Promise.all([
      stat(path.join(repositoryRoot, 'Cargo.toml')),
      stat(path.join(repositoryRoot, 'package.json')),
    ]);
    if (!cargoManifest.isFile() || !packageManifest.isFile()) {
      throw new Error('Workspace markers are not files.');
    }
  } catch {
    throw new CliResolutionError(
      'development-cli-missing',
      'SugarCode development workspace could not be resolved.',
    );
  }
};

export const resolveDevelopmentCli = async (
  desktopAppPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedCli> => {
  const repositoryRoot = path.resolve(desktopAppPath, '..', '..');
  await assertRepositoryRoot(repositoryRoot);

  const executableName = platform === 'win32' ? 'sugarcode.exe' : 'sugarcode';
  const executablePath = path.join(
    repositoryRoot,
    'target',
    'debug',
    executableName,
  );

  try {
    const metadata = await stat(executablePath);
    if (!metadata.isFile()) {
      throw new Error('Development CLI is not a file.');
    }
  } catch {
    throw new CliResolutionError(
      'development-cli-missing',
      'The SugarCode development CLI has not been built.',
    );
  }

  if (platform !== 'win32') {
    try {
      await access(executablePath, fsConstants.X_OK);
    } catch {
      throw new CliResolutionError(
        'development-cli-not-executable',
        'The SugarCode development CLI is not executable.',
      );
    }
  }

  return { executablePath, workingDirectory: repositoryRoot };
};

export const resolvePackagedCli = async (
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedCli> => {
  const executableName = platform === 'win32' ? 'sugarcode.exe' : 'sugarcode';
  const executablePath = path.join(
    resourcesPath,
    'sugarcode-sidecar',
    'bin',
    executableName,
  );

  try {
    const metadata = await stat(executablePath);
    if (!metadata.isFile()) {
      throw new Error('Packaged CLI is not a file.');
    }
  } catch {
    throw new CliResolutionError(
      'packaged-cli-missing',
      'The packaged SugarCode CLI is unavailable.',
    );
  }

  if (platform !== 'win32') {
    try {
      await access(executablePath, fsConstants.X_OK);
    } catch {
      throw new CliResolutionError(
        'packaged-cli-not-executable',
        'The packaged SugarCode CLI is not executable.',
      );
    }
  }

  return { executablePath, workingDirectory: resourcesPath };
};

export type CliResolutionOptions = Readonly<{
  isPackaged: boolean;
  desktopAppPath: string;
  resourcesPath: string;
  platform?: NodeJS.Platform;
}>;

export const resolveCli = (
  options: CliResolutionOptions,
): Promise<ResolvedCli> => {
  const platform = options.platform ?? process.platform;
  return options.isPackaged
    ? resolvePackagedCli(options.resourcesPath, platform)
    : resolveDevelopmentCli(options.desktopAppPath, platform);
};

const copyEnvironmentValue = (
  source: NodeJS.ProcessEnv,
  target: NodeJS.ProcessEnv,
  key: string,
): void => {
  const value = source[key];
  if (value !== undefined) {
    target[key] = value;
  }
};

export const createCliEnvironment = (
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  const keys =
    platform === 'win32'
      ? ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'SUGARCODE_HOME']
      : [
          'HOME',
          'TMPDIR',
          'LANG',
          'LC_ALL',
          'SUGARCODE_HOME',
          ...(platform === 'linux'
            ? ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']
            : []),
        ];
  for (const key of keys) {
    copyEnvironmentValue(source, environment, key);
  }
  return environment;
};
