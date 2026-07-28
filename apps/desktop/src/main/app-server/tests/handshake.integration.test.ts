import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConnectionSupervisor } from '../connection/supervisor';

describe('real development app-server handshake', () => {
  it('reaches ready using only the repository debug CLI path', async () => {
    const sugarcodeHome = await mkdtemp(
      path.join(tmpdir(), 'sugarcode-home-test-'),
    );
    const supervisor = new ConnectionSupervisor({
      clientVersion: '1.0.0',
      desktopAppPath: process.cwd(),
      environment: {
        PATH: '/path-that-must-not-be-used',
        SUGARCODE_HOME: sugarcodeHome,
        TMPDIR: process.env.TMPDIR,
      },
    });

    try {
      await supervisor.start();
      expect(supervisor.getSnapshot()).toMatchObject({
        status: 'ready',
      });
    } finally {
      supervisor.shutdown();
      await rm(sugarcodeHome, { force: true, recursive: true });
    }
    expect(supervisor.getSnapshot()).toMatchObject({ status: 'closed' });
  });

  it('surfaces invalid configuration without exposing its value', async () => {
    const sugarcodeHome = await mkdtemp(
      path.join(tmpdir(), 'sugarcode-home-test-'),
    );
    const sentinel = 'do-not-leak-this-secret';
    await writeFile(
      path.join(sugarcodeHome, 'config.toml'),
      `api_key = "${sentinel}"\n`,
    );
    const supervisor = new ConnectionSupervisor({
      clientVersion: '1.0.0',
      desktopAppPath: process.cwd(),
      environment: {
        SUGARCODE_HOME: sugarcodeHome,
        TMPDIR: process.env.TMPDIR,
      },
    });

    try {
      await supervisor.start();
      const snapshot = supervisor.getSnapshot();
      expect(snapshot.status).toBe('failed');
      expect(JSON.stringify(snapshot)).not.toContain(sentinel);
      expect(supervisor.getDiagnosticTailForTesting()).not.toContain(sentinel);
    } finally {
      supervisor.shutdown();
      await rm(sugarcodeHome, { force: true, recursive: true });
    }
  });
});
