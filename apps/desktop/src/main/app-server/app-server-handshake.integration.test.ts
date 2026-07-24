import { describe, expect, it } from 'vitest';

import { ConnectionSupervisor } from './connection-supervisor';

describe('real development app-server handshake', () => {
  it('reaches ready using only the repository debug CLI path', async () => {
    const supervisor = new ConnectionSupervisor({
      clientVersion: '1.0.0',
      desktopAppPath: process.cwd(),
      environment: {
        PATH: '/path-that-must-not-be-used',
        TMPDIR: process.env.TMPDIR,
      },
    });

    await supervisor.start();
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'ready',
    });
    supervisor.shutdown();
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'closed',
    });
  });
});
