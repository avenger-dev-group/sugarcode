import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import {
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from 'typescript';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return {
        shortCircuit: true,
        url: new URL(
          `../../../../src/${specifier.slice(2)}.ts`,
          import.meta.url,
        ).href,
      };
    }
    if (
      specifier.startsWith('.') &&
      !specifier.split('/').at(-1)?.includes('.') &&
      context.parentURL
    ) {
      return {
        shortCircuit: true,
        url: new URL(
          specifier === './generated'
            ? `${specifier}/index.ts`
            : `${specifier}.ts`,
          context.parentURL,
        ).href,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: {
            module: ModuleKind.ESNext,
            target: ScriptTarget.ES2022,
          },
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});

const { ConnectionSupervisor } = await import(
  '../../../../src/main/app-server/connection/supervisor.ts'
);

type WorkspaceTransactionLease = Readonly<{ release: () => void }>;

type SupervisorInternals = {
  resolvedCli: Readonly<{
    executablePath: string;
    workingDirectory: string;
  }> | null;
  client: object | null;
  workspaceTransaction: boolean;
  openConfiguredWorkspace: () => Promise<string | null>;
  beginWorkspaceTransaction: () =>
    | WorkspaceTransactionLease
    | string;
};

test('workspace switching remains available while another Thread is running', () => {
  const supervisor = new ConnectionSupervisor({
    desktopAppPath: '/test/desktop',
    clientVersion: '1.0.0',
  });
  const internals = supervisor as unknown as SupervisorInternals;
  internals.resolvedCli = {
    executablePath: '/test/sugarcode',
    workingDirectory: '/test',
  };
  internals.client = {};

  const idleSnapshot = supervisor.conversation.getSnapshot();
  supervisor.conversation.getSnapshot = () => ({
    ...idleSnapshot,
    phase: 'inProgress',
  });

  assert.equal(supervisor.getWorkspaceSwitchBlock(), null);
  const lease = internals.beginWorkspaceTransaction();
  if (typeof lease === 'string') {
    assert.fail(`workspace switch was blocked: ${lease}`);
  }
  assert.equal(internals.workspaceTransaction, true);

  lease.release();
  assert.equal(internals.workspaceTransaction, false);

  supervisor.conversation.getSnapshot = () => ({
    ...idleSnapshot,
    phase: 'starting',
  });
  assert.equal(supervisor.getWorkspaceSwitchBlock(), null);
  const startingLease = internals.beginWorkspaceTransaction();
  if (typeof startingLease === 'string') {
    assert.fail(`starting Turn blocked workspace switch: ${startingLease}`);
  }
  startingLease.release();
});

test('workspace switching serializes behind an accepted Turn start', async () => {
  const supervisor = new ConnectionSupervisor({
    desktopAppPath: '/test/desktop',
    clientVersion: '1.0.0',
  });
  const internals = supervisor as unknown as SupervisorInternals;
  internals.resolvedCli = {
    executablePath: '/test/sugarcode',
    workingDirectory: '/test',
  };
  internals.client = {};

  const events: string[] = [];
  let settleTurnStart = (): void => undefined;
  const turnStartSettlement = new Promise<void>((resolve) => {
    settleTurnStart = resolve;
  });
  supervisor.conversation.waitForTurnStartSettlement = async () => {
    events.push('wait');
    await turnStartSettlement;
    events.push('settled');
  };
  internals.openConfiguredWorkspace = async () => {
    events.push('open');
    return 'workspace-admin';
  };
  supervisor.conversation.switchWorkspace = async () => {
    events.push('switch');
    return true;
  };

  const switching = supervisor.switchWorkspace('/test/admin');
  await Promise.resolve();
  assert.deepEqual(events, ['wait']);
  assert.equal(internals.workspaceTransaction, true);

  settleTurnStart();
  assert.equal(await switching, true);
  assert.deepEqual(events, ['wait', 'settled', 'open', 'switch']);
  assert.equal(internals.workspaceTransaction, false);
});
