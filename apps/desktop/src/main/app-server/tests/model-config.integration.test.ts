import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConnectionSupervisor } from '../connection/supervisor';
import { ModelConfigController } from '../model-config/controller';

describe('real development model configuration reconnect', () => {
  it('saves through the Rust contract and reconnects the real sidecar without MCP', async () => {
    const sugarcodeHome = await mkdtemp(
      path.join(tmpdir(), 'sugarcode-model-config-test-'),
    );
    const supervisor = new ConnectionSupervisor({
      clientVersion: '1.0.0',
      desktopAppPath: process.cwd(),
      environment: {
        SUGARCODE_HOME: sugarcodeHome,
        TMPDIR: process.env.TMPDIR,
      },
    });
    const controller = new ModelConfigController({ supervisor });

    try {
      await supervisor.start();
      expect(supervisor.getSnapshot().status).toBe('ready');
      const missingModelTurn =
        await supervisor.conversation.startTurn(
          'Create the durable Thread before model setup.',
        );
      expect(missingModelTurn.accepted).toBe(false);
      const exactThreadId =
        supervisor.conversation.getSnapshot().threadId;
      expect(exactThreadId).toMatch(/^thr_/u);
      const before = await controller.inspect();
      expect(before.config).toBeNull();

      const result = await controller.save({
        expectedRevision: before.revision,
        config: {
          apiFormat: 'openai-chat-completions',
          endpoint: 'http://127.0.0.1:18080/v1/chat/completions',
          model: 'fixture-model',
          credentialReference: null,
        },
      });
      expect(result).toMatchObject({
        accepted: true,
        state: 'active',
        inspection: {
          config: {
            endpoint:
              'http://127.0.0.1:18080/v1/chat/completions',
            model: 'fixture-model',
          },
          credentialStatus: 'notConfigured',
        },
      });
      expect(supervisor.getSnapshot().status).toBe('ready');
      expect(supervisor.conversation.getSnapshot().threadId).toBe(
        exactThreadId,
      );
      expect(supervisor.mcpSession.getSnapshot()).toMatchObject({
        status: 'disabled',
        selectedServerIds: [],
        activeServerIds: [],
      });
      const stored = await readFile(
        path.join(sugarcodeHome, 'config.toml'),
        'utf8',
      );
      expect(stored).toContain('model = "fixture-model"');
      expect(stored).not.toContain('token');
    } finally {
      supervisor.shutdown();
      await rm(sugarcodeHome, { force: true, recursive: true });
    }
  });
});
