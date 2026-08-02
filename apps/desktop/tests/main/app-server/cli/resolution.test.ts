import assert from 'node:assert/strict';
import test from 'node:test';

import { createCliEnvironment } from '../../../../src/main/app-server/cli/resolution.ts';

test('CLI inherits the host process environment used by local toolchains', () => {
  const source: NodeJS.ProcessEnv = {
    PATH: '/host/node/bin:/host/java/bin:/usr/bin',
    HOME: '/host/home',
    JAVA_HOME: '/host/java',
    NVM_BIN: '/host/node/bin',
    PNPM_HOME: '/host/pnpm',
    SUGARCODE_HOME: '/host/sugarcode',
  };

  const environment = createCliEnvironment(source);

  assert.deepEqual(environment, source);
  assert.notEqual(environment, source);
});
