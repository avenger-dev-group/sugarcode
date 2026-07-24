import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createDevelopmentCliEnvironment,
  resolveDevelopmentCli,
} from '../development-cli';

const temporaryRoots: string[] = [];

const createWorkspace = async (): Promise<{
  desktopAppPath: string;
  executablePath: string;
  repositoryRoot: string;
}> => {
  const repositoryRoot = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'sugarcode-cli-test-')),
  );
  temporaryRoots.push(repositoryRoot);
  const desktopAppPath = path.join(repositoryRoot, 'apps', 'desktop');
  const executablePath = path.join(
    repositoryRoot,
    'target',
    'debug',
    'sugarcode',
  );
  await Promise.all([
    mkdir(desktopAppPath, { recursive: true }),
    mkdir(path.dirname(executablePath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(repositoryRoot, 'Cargo.toml'), '[workspace]\n'),
    writeFile(path.join(repositoryRoot, 'package.json'), '{}\n'),
    writeFile(executablePath, '#!/bin/sh\n'),
  ]);
  await chmod(executablePath, 0o755);
  return { desktopAppPath, executablePath, repositoryRoot };
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

describe('resolveDevelopmentCli', () => {
  it('resolves the fixed workspace debug binary without PATH', async () => {
    const workspace = await createWorkspace();

    await expect(
      resolveDevelopmentCli(workspace.desktopAppPath, 'darwin'),
    ).resolves.toEqual({
      executablePath: workspace.executablePath,
      repositoryRoot: workspace.repositoryRoot,
    });
  });

  it('fails explicitly when the CLI is missing or not executable', async () => {
    const workspace = await createWorkspace();
    await chmod(workspace.executablePath, 0o644);

    await expect(
      resolveDevelopmentCli(workspace.desktopAppPath, 'linux'),
    ).rejects.toMatchObject({
      code: 'development-cli-not-executable',
    });
    await expect(
      resolveDevelopmentCli(path.join(workspace.repositoryRoot, 'missing')),
    ).rejects.toMatchObject({
      code: 'development-cli-missing',
    });
  });
});

describe('createDevelopmentCliEnvironment', () => {
  it('allowlists platform essentials and omits PATH and secrets', () => {
    expect(
      createDevelopmentCliEnvironment(
        {
          LANG: 'en_US.UTF-8',
          PATH: '/untrusted',
          SECRET_TOKEN: 'secret',
          TMPDIR: '/tmp',
        },
        'linux',
      ),
    ).toEqual({
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
    });
  });
});
