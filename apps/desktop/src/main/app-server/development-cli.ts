import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

export type DevelopmentCli = Readonly<{
  executablePath: string;
  repositoryRoot: string;
}>;

export type DevelopmentCliErrorCode =
  | 'development-cli-missing'
  | 'development-cli-not-executable';

export class DevelopmentCliError extends Error {
  readonly code: DevelopmentCliErrorCode;

  constructor(code: DevelopmentCliErrorCode, message: string) {
    super(message);
    this.name = 'DevelopmentCliError';
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
    throw new DevelopmentCliError(
      'development-cli-missing',
      'SugarCode development workspace could not be resolved.',
    );
  }
};

export const resolveDevelopmentCli = async (
  desktopAppPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<DevelopmentCli> => {
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
    throw new DevelopmentCliError(
      'development-cli-missing',
      'The SugarCode development CLI has not been built.',
    );
  }

  if (platform !== 'win32') {
    try {
      await access(executablePath, fsConstants.X_OK);
    } catch {
      throw new DevelopmentCliError(
        'development-cli-not-executable',
        'The SugarCode development CLI is not executable.',
      );
    }
  }

  return { executablePath, repositoryRoot };
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

export const createDevelopmentCliEnvironment = (
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  const keys =
    platform === 'win32'
      ? ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']
      : ['TMPDIR', 'LANG', 'LC_ALL'];
  for (const key of keys) {
    copyEnvironmentValue(source, environment, key);
  }
  return environment;
};
