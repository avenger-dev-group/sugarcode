import {
  PROTOCOL_VERSION,
  SUGARCODE_PRODUCT_VERSION,
} from '@sugarcode/app-server-protocol';
import type {
  ForgeArch,
  ForgeHookFn,
  ForgePlatform,
  ResolvedForgeConfig,
} from '@electron-forge/shared-types';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, rmSync } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createCliEnvironment,
  resolvePackagedCli,
} from '../src/main/app-server/cli/resolution';
import {
  requireNativeCliTarget,
  type CliTarget,
} from '../src/main/app-server/cli/platform';
import { JsonlClient } from '../src/main/app-server/transport/jsonl-client';

const RESOURCE_DIRECTORY_NAME = 'sugarcode-sidecar';
const PROCESS_OUTPUT_LIMIT = 64 * 1024;
const VERSION_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const TERMINAL_TIMEOUT_MS = 20_000;

export type SidecarManifest = Readonly<{
  schemaVersion: 1;
  productVersion: string;
  protocolVersion: number;
  platform: CliTarget['platform'];
  arch: CliTarget['arch'];
  targetTriple: string;
  executable: string;
  sha256: string;
}>;

type ProcessResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

type ProcessOptions = SpawnOptionsWithoutStdio &
  Readonly<{
    timeoutMs: number;
    expectedExitCodes?: readonly number[];
  }>;

type PreparedSidecar = Readonly<{
  temporaryRoot: string;
  verificationHome: string;
  resourceDirectory: string;
  sourceExecutablePath: string;
  target: CliTarget;
  manifest: SidecarManifest;
  productName: string;
}>;

type PackageResult = Readonly<{
  platform: ForgePlatform;
  arch: ForgeArch;
  outputPaths: string[];
}>;

type SidecarHookOptions = Readonly<{
  workspaceRoot: string;
  desktopRoot: string;
  hostPlatform?: NodeJS.Platform;
  hostArch?: string;
}>;

const temporaryRoots = new Set<string>();
let exitCleanupRegistered = false;

const registerTemporaryRoot = (temporaryRoot: string): void => {
  temporaryRoots.add(temporaryRoot);
  if (!exitCleanupRegistered) {
    exitCleanupRegistered = true;
    process.once('exit', () => {
      for (const root of temporaryRoots) {
        rmSync(root, { force: true, recursive: true });
      }
    });
  }
};

const cleanupTemporaryRoot = async (temporaryRoot: string): Promise<void> => {
  temporaryRoots.delete(temporaryRoot);
  await rm(temporaryRoot, { force: true, recursive: true });
};

const appendBounded = (current: string, chunk: Buffer | string): string => {
  const combined = current + chunk.toString();
  return combined.length <= PROCESS_OUTPUT_LIMIT
    ? combined
    : combined.slice(-PROCESS_OUTPUT_LIMIT);
};

const runProcess = (
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const {
      timeoutMs,
      expectedExitCodes = [0],
      ...spawnOptions
    } = options;
    const child = spawn(command, args, {
      ...spawnOptions,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Process timed out: ${command}.`));
      } else if (
        code === null ||
        !expectedExitCodes.includes(code) ||
        signal !== null
      ) {
        reject(
          new Error(
            `Process failed: ${command} ${args.join(' ')}\n${stderr}`.trim(),
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });

const assertFile = async (
  filePath: string,
  platform: NodeJS.Platform,
  executable = false,
): Promise<void> => {
  const metadata = await stat(filePath);
  if (!metadata.isFile()) {
    throw new Error(`Expected a file at ${filePath}.`);
  }
  if (executable && platform !== 'win32') {
    await access(filePath, fsConstants.X_OK);
  }
};

const sha256File = async (filePath: string): Promise<string> => {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
};

const verifyVersion = async (
  executablePath: string,
  workingDirectory: string,
  target: CliTarget,
  verificationHome: string,
): Promise<void> => {
  const environment = createCliEnvironment(
    {
      ...process.env,
      SUGARCODE_HOME: verificationHome,
    },
    target.platform,
  );
  const result = await runProcess(executablePath, ['version'], {
    cwd: workingDirectory,
    env: environment,
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  const expected =
    `sugarcode ${SUGARCODE_PRODUCT_VERSION}\n` +
    `app-server-protocol ${PROTOCOL_VERSION}\n`;
  if (result.stdout !== expected) {
    throw new Error('The packaged CLI reported unexpected versions.');
  }
};

const verifyExec = async (
  executablePath: string,
  workingDirectory: string,
  target: CliTarget,
  verificationHome: string,
): Promise<void> => {
  const result = await runProcess(
    executablePath,
    ['exec', '--json', 'packaged headless exec smoke'],
    {
      cwd: workingDirectory,
      env: createCliEnvironment(
        {
          ...process.env,
          SUGARCODE_HOME: verificationHome,
        },
        target.platform,
      ),
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
      expectedExitCodes: [3],
    },
  );
  const records = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const error = records.at(-1);
  if (
    records[0]?.type !== 'runStarted' ||
    error?.type !== 'error' ||
    error.version !== 1 ||
    error.exitCode !== 3 ||
    error.category !== 'configuration'
  ) {
    throw new Error('The packaged headless exec smoke check failed.');
  }
};

const verifyTuiRoute = async (
  executablePath: string,
  workingDirectory: string,
  target: CliTarget,
  verificationHome: string,
): Promise<void> => {
  const result = await runProcess(executablePath, [], {
    cwd: workingDirectory,
    env: createCliEnvironment(
      {
        ...process.env,
        SUGARCODE_HOME: verificationHome,
      },
      target.platform,
    ),
    timeoutMs: HANDSHAKE_TIMEOUT_MS,
    expectedExitCodes: [1],
  });
  if (
    result.stdout !== '' ||
    !result.stderr.includes(
      'interactive TUI requires terminal stdin and stdout',
    ) ||
    !result.stderr.includes('sugarcode exec')
  ) {
    throw new Error('The packaged TUI route smoke check failed.');
  }
};

const waitForCleanExit = (
  child: ChildProcessWithoutNullStreams,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The packaged CLI did not exit after the handshake.'));
    }, HANDSHAKE_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(
          new Error(
            `The packaged CLI exited unexpectedly: code=${String(code)}, signal=${String(signal)}.`,
          ),
        );
      }
    });
  });

const verifyTerminalBridge = async (
  executablePath: string,
  workspace: string,
  verificationHome: string,
): Promise<void> => {
  const canonicalWorkspace = await realpath(workspace);
  const child = spawn(
    executablePath,
    [
      '__desktop-terminal',
      '--workspace',
      canonicalWorkspace,
      '--columns',
      '80',
      '--rows',
      '24',
    ],
    {
      cwd: canonicalWorkspace,
      env: {
        ...process.env,
        SUGARCODE_HOME: verificationHome,
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  await new Promise<void>((resolve, reject) => {
    let stdoutBuffer = '';
    let stderr = '';
    let transcript = '';
    let ready = false;
    let exitEvent = false;
    let cursorAnswered = false;
    let tuiExitSent = false;
    let shellExitSent = false;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new Error(
          `The packaged CLI terminal bridge timed out: ready=${String(ready)}, tuiExit=${String(tuiExitSent)}, shellExit=${String(shellExitSent)}, transcript=${JSON.stringify(transcript.slice(-2_000))}.`,
        ),
      );
    }, TERMINAL_TIMEOUT_MS);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      if (stdoutBuffer.length > PROCESS_OUTPUT_LIMIT) {
        child.kill();
        finish(new Error('The packaged terminal protocol exceeded its bound.'));
        return;
      }
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          child.kill();
          finish(new Error('The packaged terminal emitted invalid JSON.'));
          return;
        }
        if (event.type === 'ready' && event.version === 1 && !ready) {
          ready = true;
          child.stdin.write(
            `${JSON.stringify({
              type: 'resize',
              sequence: 1,
              columns: 91,
              rows: 32,
            })}\n`,
          );
          const quotedExecutable =
            process.platform === 'win32'
              ? `"${executablePath.replaceAll('"', '""')}"`
              : `'${executablePath.replaceAll("'", "'\\''")}'`;
          const quotedHome =
            process.platform === 'win32'
              ? `"${verificationHome.replaceAll('"', '""')}"`
              : `'${verificationHome.replaceAll("'", "'\\''")}'`;
          const input =
            process.platform === 'win32'
              ? `echo SUGARCODE_PACKAGED_PTY\r\n${quotedExecutable} --home ${quotedHome}\r\n`
              : `printf 'SUGARCODE_PACKAGED_PTY\\n'\n${quotedExecutable} --home ${quotedHome}\n`;
          child.stdin.write(
            `${JSON.stringify({
              type: 'input',
              sequence: 2,
              data: input,
            })}\n`,
          );
        } else if (
          event.type === 'output' &&
          typeof event.data === 'string'
        ) {
          transcript = appendBounded(transcript, event.data);
          if (!cursorAnswered && transcript.includes('\u001b[6n')) {
            cursorAnswered = true;
            child.stdin.write(
              `${JSON.stringify({
                type: 'input',
                sequence: 3,
                data: '\u001b[24;1R',
              })}\n`,
            );
          }
          if (!tuiExitSent && transcript.includes(' SugarCode ')) {
            tuiExitSent = true;
            child.stdin.write(
              `${JSON.stringify({
                type: 'input',
                sequence: 4,
                data: '\u0011',
              })}\n`,
            );
          }
          if (
            tuiExitSent &&
            !shellExitSent &&
            transcript.includes('\u001b[?1049l')
          ) {
            shellExitSent = true;
            child.stdin.write(
              `${JSON.stringify({
                type: 'input',
                sequence: 5,
                data: process.platform === 'win32' ? 'exit\r\n' : 'exit\n',
              })}\n`,
            );
          }
        } else if (event.type === 'exit') {
          exitEvent =
            event.reason === 'natural' &&
            typeof event.exitCode === 'number';
        } else if (event.type === 'error') {
          child.kill();
          finish(
            new Error(
              `The packaged terminal bridge reported an error: code=${String(event.code)}, message=${String(event.message)}.`,
            ),
          );
          return;
        }
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (
        code === 0 &&
        signal === null &&
        ready &&
        exitEvent &&
        transcript.includes('SUGARCODE_PACKAGED_PTY') &&
        transcript.includes(' SugarCode ') &&
        transcript.includes('\u001b[?1049h') &&
        transcript.includes('\u001b[?1049l')
      ) {
        finish();
      } else {
        finish(
          new Error(
            `The packaged terminal smoke failed: code=${String(code)}, signal=${String(signal)}, stderr=${stderr}`,
          ),
        );
      }
    });
  });
};

const verifyHandshake = async (
  executablePath: string,
  target: CliTarget,
  verificationHome: string,
): Promise<void> => {
  const verificationWorkspace = await mkdtemp(
    path.join(
      path.dirname(verificationHome),
      'verification-workspace-',
    ),
  );
  const initialInspectionFixture = 'packaged workspace inspection\n';
  const inspectionFixture =
    'packaged workspace inspection\nchanged in package smoke\n';
  await writeFile(
    path.join(verificationWorkspace, 'inspection.txt'),
    initialInspectionFixture,
    'utf8',
  );
  await runProcess('git', ['init', '--initial-branch=main'], {
    cwd: verificationWorkspace,
    env: process.env,
    timeoutMs: HANDSHAKE_TIMEOUT_MS,
  });
  await runProcess(
    'git',
    ['config', 'user.name', 'SugarCode Package'],
    {
      cwd: verificationWorkspace,
      env: process.env,
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
    },
  );
  await runProcess(
    'git',
    ['config', 'user.email', 'package@example.invalid'],
    {
      cwd: verificationWorkspace,
      env: process.env,
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
    },
  );
  await runProcess('git', ['add', 'inspection.txt'], {
    cwd: verificationWorkspace,
    env: process.env,
    timeoutMs: HANDSHAKE_TIMEOUT_MS,
  });
  await runProcess('git', ['commit', '-m', 'initial package fixture'], {
    cwd: verificationWorkspace,
    env: process.env,
    timeoutMs: HANDSHAKE_TIMEOUT_MS,
  });
  await writeFile(
    path.join(verificationWorkspace, 'inspection.txt'),
    inspectionFixture,
    'utf8',
  );
  const environment = createCliEnvironment(
    {
      ...process.env,
      SUGARCODE_HOME: verificationHome,
    },
    target.platform,
  );
  const child = spawn(
    executablePath,
    ['app-server', '--stdio', '--workspace', verificationWorkspace],
    {
      cwd: verificationWorkspace,
      detached: false,
      env: environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const exit = waitForCleanExit(child);
  let fatalError: Error | null = null;
  const client = new JsonlClient({
    stdin: child.stdin,
    stdout: child.stdout,
    onFatalError: (error) => {
      fatalError = error;
    },
    onServerRequest: () => {
      fatalError = new Error('Unexpected server request during handshake.');
    },
  });

  try {
    const response = await client.initialize(
      {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: {
          name: 'sugarcode-desktop-package',
          title: 'SugarCode Desktop Package',
          version: SUGARCODE_PRODUCT_VERSION,
        },
        capabilities: { commandApprovals: true },
      },
      AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    );
    if (
      response.protocolVersion !== PROTOCOL_VERSION ||
      response.serverInfo.name !== 'sugarcode' ||
      response.serverInfo.version !== SUGARCODE_PRODUCT_VERSION ||
      response.platform.family !== target.expectedPlatform.family ||
      response.platform.os !== target.expectedPlatform.os ||
      response.platform.arch !== target.expectedPlatform.arch ||
      response.capabilities.workspaceBrowser !== true ||
      response.capabilities.workspaceGit !== true ||
      !response.workspace ||
      !/^[0-9a-f]{64}$/.test(response.workspace.id)
    ) {
      throw new Error('The packaged CLI handshake did not match its target.');
    }
    await client.initialized();
    const listing = await client.requestReady(
      'workspace/list',
      { path: '' },
      AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    );
    const inspection = await client.requestReady(
      'workspace/inspect',
      { path: 'inspection.txt' },
      AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    );
    if (
      !listing ||
      typeof listing !== 'object' ||
      !Array.isArray((listing as { entries?: unknown }).entries) ||
      !(listing as { entries: unknown[] }).entries.some(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          (entry as { path?: unknown }).path === 'inspection.txt' &&
          (entry as { kind?: unknown }).kind === 'file',
      ) ||
      !inspection ||
      typeof inspection !== 'object' ||
      (inspection as { status?: unknown }).status !== 'complete' ||
      (inspection as { path?: unknown }).path !== 'inspection.txt' ||
      (inspection as { content?: unknown }).content !== inspectionFixture
    ) {
      throw new Error('The packaged CLI workspace browser smoke check failed.');
    }
    const gitStatus = await client.requestReady(
      'workspace/git/status',
      {},
      AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    );
    if (
      !gitStatus ||
      typeof gitStatus !== 'object' ||
      (gitStatus as { status?: unknown }).status !== 'ready' ||
      (gitStatus as { unstagedCount?: unknown }).unstagedCount !== 1 ||
      typeof (gitStatus as { revision?: unknown }).revision !== 'string'
    ) {
      throw new Error('The packaged CLI Git status smoke check failed.');
    }
    const worktreeRevision = (gitStatus as { revision: string }).revision;
    const gitDiff = await client.requestReady(
      'workspace/git/diff',
      {
        expectedRevision: worktreeRevision,
        path: 'inspection.txt',
        source: 'worktree',
      },
      AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    );
    if (
      !gitDiff ||
      typeof gitDiff !== 'object' ||
      (gitDiff as { status?: unknown }).status !== 'ready' ||
      !(gitDiff as { content?: unknown }).content ||
      !(gitDiff as { content: string }).content.includes(
        '+changed in package smoke',
      )
    ) {
      throw new Error('The packaged CLI Git diff smoke check failed.');
    }
    const staged = await client.requestReady(
      'workspace/git/stage',
      {
        expectedRevision: worktreeRevision,
        paths: ['inspection.txt'],
      },
      AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    );
    if (
      !staged ||
      typeof staged !== 'object' ||
      (staged as { status?: unknown }).status !== 'applied' ||
      typeof (staged as { revision?: unknown }).revision !== 'string'
    ) {
      throw new Error('The packaged CLI Git stage smoke check failed.');
    }
    const unstaged = await client.requestReady(
      'workspace/git/unstage',
      {
        expectedRevision: (staged as { revision: string }).revision,
        paths: ['inspection.txt'],
      },
      AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    );
    if (
      !unstaged ||
      typeof unstaged !== 'object' ||
      (unstaged as { status?: unknown }).status !== 'applied' ||
      typeof (unstaged as { revision?: unknown }).revision !== 'string'
    ) {
      throw new Error('The packaged CLI Git unstage smoke check failed.');
    }
    const restaged = await client.requestReady(
      'workspace/git/stage',
      {
        expectedRevision: (unstaged as { revision: string }).revision,
        paths: ['inspection.txt'],
      },
      AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    );
    if (
      !restaged ||
      typeof restaged !== 'object' ||
      (restaged as { status?: unknown }).status !== 'applied' ||
      typeof (restaged as { revision?: unknown }).revision !== 'string'
    ) {
      throw new Error('The packaged CLI Git restage smoke check failed.');
    }
    const committed = await client.requestReady(
      'workspace/git/commit',
      {
        expectedRevision: (restaged as { revision: string }).revision,
        message: 'verify packaged Git workbench',
        authorName: 'SugarCode Package',
        authorEmail: 'package@example.invalid',
      },
      AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    );
    if (
      !committed ||
      typeof committed !== 'object' ||
      (committed as { status?: unknown }).status !== 'committed' ||
      typeof (committed as { newHead?: unknown }).newHead !== 'string'
    ) {
      throw new Error('The packaged CLI Git commit smoke check failed.');
    }
    const actualHead = await runProcess('git', ['rev-parse', 'HEAD'], {
      cwd: verificationWorkspace,
      env: process.env,
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
    });
    if (
      actualHead.stdout.trim() !==
      (committed as { newHead: string }).newHead
    ) {
      throw new Error('The packaged CLI Git commit receipt did not reconcile.');
    }
    if (fatalError) {
      throw fatalError;
    }
    client.close();
    await exit;
    await verifyTerminalBridge(
      executablePath,
      verificationWorkspace,
      verificationHome,
    );
  } catch (error) {
    client.close();
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
    void exit.catch((): undefined => undefined);
    throw error;
  }
};

const verifyExecutable = async (
  executablePath: string,
  workingDirectory: string,
  target: CliTarget,
  verificationHome: string,
): Promise<void> => {
  await assertFile(executablePath, target.platform, true);
  await verifyVersion(
    executablePath,
    workingDirectory,
    target,
    verificationHome,
  );
  await verifyExec(
    executablePath,
    workingDirectory,
    target,
    verificationHome,
  );
  await verifyTuiRoute(
    executablePath,
    workingDirectory,
    target,
    verificationHome,
  );
  await verifyHandshake(
    executablePath,
    target,
    verificationHome,
  );
};

const readDesktopPackage = async (
  desktopRoot: string,
): Promise<Readonly<{ productName: string; version: string }>> => {
  const packageJson = JSON.parse(
    await readFile(path.join(desktopRoot, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  if (
    typeof packageJson.productName !== 'string' ||
    typeof packageJson.version !== 'string'
  ) {
    throw new Error('Desktop package metadata is incomplete.');
  }
  if (packageJson.version !== SUGARCODE_PRODUCT_VERSION) {
    throw new Error('Desktop and generated product versions do not match.');
  }
  return {
    productName: packageJson.productName,
    version: packageJson.version,
  };
};

export const preparePackagedSidecar = async (
  options: SidecarHookOptions,
  platform: string,
  arch: string,
): Promise<PreparedSidecar> => {
  const target = requireNativeCliTarget(
    platform,
    arch,
    options.hostPlatform,
    options.hostArch,
  );
  const desktopPackage = await readDesktopPackage(options.desktopRoot);
  const rustHost = await runProcess('rustc', ['--print', 'host-tuple'], {
    cwd: options.workspaceRoot,
    env: process.env,
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (rustHost.stdout.trim() !== target.rustTriple) {
    throw new Error(
      `Rust host ${rustHost.stdout.trim()} does not match ${target.rustTriple}.`,
    );
  }

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), 'sugarcode-sidecar-'),
  );
  registerTemporaryRoot(temporaryRoot);
  try {
    const verificationHome = path.join(
      temporaryRoot,
      'verification-home',
    );
    await mkdir(verificationHome);
    const cargoTarget = path.join(temporaryRoot, 'cargo-target');
    await runProcess(
      'cargo',
      [
        'build',
        '--locked',
        '--release',
        '--package',
        'sugarcode-cli',
        '--bin',
        'sugarcode',
        '--target',
        target.rustTriple,
        '--target-dir',
        cargoTarget,
      ],
      {
        cwd: options.workspaceRoot,
        env: process.env,
        timeoutMs: BUILD_TIMEOUT_MS,
      },
    );

    const sourceExecutablePath = path.join(
      cargoTarget,
      target.rustTriple,
      'release',
      target.executableName,
    );
    await verifyExecutable(
      sourceExecutablePath,
      options.workspaceRoot,
      target,
      verificationHome,
    );

    const resourceDirectory = path.join(
      temporaryRoot,
      RESOURCE_DIRECTORY_NAME,
    );
    const stagedExecutablePath = path.join(
      resourceDirectory,
      'bin',
      target.executableName,
    );
    await mkdir(path.dirname(stagedExecutablePath), { recursive: true });
    await copyFile(sourceExecutablePath, stagedExecutablePath);
    if (target.platform !== 'win32') {
      await chmod(stagedExecutablePath, 0o755);
    }
    await assertFile(stagedExecutablePath, target.platform, true);
    await copyFile(
      path.join(options.workspaceRoot, 'THIRD_PARTY_NOTICES.txt'),
      path.join(resourceDirectory, 'THIRD_PARTY_NOTICES.txt'),
    );
    await assertFile(
      path.join(resourceDirectory, 'THIRD_PARTY_NOTICES.txt'),
      target.platform,
    );

    const sourceHash = await sha256File(sourceExecutablePath);
    const stagedHash = await sha256File(stagedExecutablePath);
    if (sourceHash !== stagedHash) {
      throw new Error('The staged CLI does not match the built executable.');
    }
    const manifest: SidecarManifest = {
      schemaVersion: 1,
      productVersion: SUGARCODE_PRODUCT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      platform: target.platform,
      arch: target.arch,
      targetTriple: target.rustTriple,
      executable: path.posix.join('bin', target.executableName),
      sha256: sourceHash,
    };
    await writeFile(
      path.join(resourceDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    return {
      temporaryRoot,
      verificationHome,
      resourceDirectory,
      sourceExecutablePath,
      target,
      manifest,
      productName: desktopPackage.productName,
    };
  } catch (error) {
    await cleanupTemporaryRoot(temporaryRoot);
    throw error;
  }
};

export const getPackagedResourcesPath = (
  outputPath: string,
  platform: string,
  productName: string,
): string => {
  if (platform === 'darwin') {
    return path.join(
      outputPath,
      `${productName}.app`,
      'Contents',
      'Resources',
    );
  }
  if (platform === 'linux' || platform === 'win32') {
    return path.join(outputPath, 'resources');
  }
  throw new Error(`Unsupported package output platform: ${platform}.`);
};

const parseManifest = async (
  manifestPath: string,
): Promise<SidecarManifest> => {
  const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    typeof value !== 'object' ||
    value === null ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          'arch',
          'executable',
          'platform',
          'productVersion',
          'protocolVersion',
          'schemaVersion',
          'sha256',
          'targetTriple',
        ].sort(),
      )
  ) {
    throw new Error('The packaged sidecar manifest is invalid.');
  }
  return value as SidecarManifest;
};

export const smokePackagedSidecar = async (
  prepared: PreparedSidecar,
  packageResult: PackageResult,
): Promise<void> => {
  if (
    packageResult.platform !== prepared.target.platform ||
    packageResult.arch !== prepared.target.arch ||
    packageResult.outputPaths.length !== 1
  ) {
    throw new Error('Forge returned an unexpected package target.');
  }
  const resourcesPath = getPackagedResourcesPath(
    packageResult.outputPaths[0],
    prepared.target.platform,
    prepared.productName,
  );
  await assertFile(path.join(resourcesPath, 'app.asar'), prepared.target.platform);
  const resourceDirectory = path.join(
    resourcesPath,
    RESOURCE_DIRECTORY_NAME,
  );
  const resourceEntries = (
    await readdir(resourceDirectory)
  ).sort();
  if (
    JSON.stringify(resourceEntries) !==
    JSON.stringify([
      'THIRD_PARTY_NOTICES.txt',
      'bin',
      'manifest.json',
    ])
  ) {
    throw new Error('The packaged sidecar resource layout is not exact.');
  }
  const packagedManifest = await parseManifest(
    path.join(resourceDirectory, 'manifest.json'),
  );
  if (JSON.stringify(packagedManifest) !== JSON.stringify(prepared.manifest)) {
    throw new Error('The packaged sidecar manifest changed during packaging.');
  }
  const binEntries = await readdir(path.join(resourceDirectory, 'bin'));
  if (
    binEntries.length !== 1 ||
    binEntries[0] !== prepared.target.executableName
  ) {
    throw new Error('The packaged sidecar must contain one exact executable.');
  }
  const packagedCli = await resolvePackagedCli(
    resourcesPath,
    prepared.target.platform,
  );
  const packagedHash = await sha256File(packagedCli.executablePath);
  if (packagedHash !== prepared.manifest.sha256) {
    throw new Error('The packaged CLI does not match the verified build.');
  }
  await verifyExecutable(
    packagedCli.executablePath,
    packagedCli.workingDirectory,
    prepared.target,
    prepared.verificationHome,
  );
};

const setExtraResource = (
  forgeConfig: ResolvedForgeConfig,
  resourceDirectory: string,
  previousResourceDirectory?: string,
): void => {
  forgeConfig.packagerConfig ??= {};
  const configured = forgeConfig.packagerConfig.extraResource;
  const resources =
    configured === undefined
      ? []
      : Array.isArray(configured)
        ? configured
        : [configured];
  forgeConfig.packagerConfig.extraResource = [
    ...resources.filter((resource) => resource !== previousResourceDirectory),
    resourceDirectory,
  ];
};

export const createPackagedSidecarHooks = (
  options: SidecarHookOptions,
): Readonly<{
  prePackage: ForgeHookFn<'prePackage'>;
  postPackage: ForgeHookFn<'postPackage'>;
}> => {
  let active: PreparedSidecar | null = null;
  let previousResourceDirectory: string | undefined;

  return {
    prePackage: async (forgeConfig, platform, arch) => {
      if (active) {
        throw new Error('A packaged CLI build is already active.');
      }
      active = await preparePackagedSidecar(
        options,
        String(platform),
        String(arch),
      );
      setExtraResource(
        forgeConfig,
        active.resourceDirectory,
        previousResourceDirectory,
      );
      previousResourceDirectory = active.resourceDirectory;
    },
    postPackage: async (_forgeConfig, packageResult) => {
      if (!active) {
        throw new Error('No packaged CLI build is active.');
      }
      const prepared = active;
      try {
        await smokePackagedSidecar(prepared, packageResult);
      } finally {
        active = null;
        await cleanupTemporaryRoot(prepared.temporaryRoot);
      }
    },
  };
};
