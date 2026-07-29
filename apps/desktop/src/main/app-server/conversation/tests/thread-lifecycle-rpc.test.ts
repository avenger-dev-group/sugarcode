import { describe, expect, it, vi } from 'vitest';

import type { JsonlClient } from '../../transport/jsonl-client';
import { ConversationRpcClient } from '../rpc-client';

const THREAD_A = 'thr_0000000000000001';
const THREAD_FORK = 'thr_0000000000000002';

describe('Thread lifecycle RPC', () => {
  it('uses the exact public methods and validates lifecycle responses', async () => {
    const requestReady = vi.fn(
      async (method: string, _params: unknown): Promise<unknown> => {
        void _params;
        if (method === 'thread/fork') {
          return {
            thread: { id: THREAD_FORK },
            turns: [
              {
                id: 'turn_0000000000000001',
                status: 'completed',
                items: [
                  {
                    type: 'agentMessage',
                    id: 'item_0000000000000001',
                    text: 'Forked durable answer.',
                  },
                ],
              },
            ],
          };
        }
        return {};
      },
    );
    const client = new ConversationRpcClient({
      requestReady,
    } as unknown as JsonlClient);

    await expect(client.forkThread(THREAD_A)).resolves.toMatchObject({
      threadId: THREAD_FORK,
      turns: [{ items: [{ text: 'Forked durable answer.' }] }],
    });
    await expect(client.archiveThread(THREAD_A)).resolves.toBeUndefined();
    await expect(
      client.unarchiveThread(THREAD_A),
    ).resolves.toBeUndefined();
    await expect(client.deleteThread(THREAD_A)).resolves.toBeUndefined();

    expect(requestReady.mock.calls.map(([method, params]) => [
      method,
      params,
    ])).toEqual([
      ['thread/fork', { threadId: THREAD_A }],
      ['thread/archive', { threadId: THREAD_A }],
      ['thread/unarchive', { threadId: THREAD_A }],
      ['thread/delete', { threadId: THREAD_A }],
    ]);
  });

  it('rejects malformed fork and empty lifecycle receipts', async () => {
    const requestReady = vi
      .fn()
      .mockResolvedValueOnce({
        thread: { id: THREAD_FORK },
        turns: [{ id: 'turn_invalid', status: 'completed' }],
      })
      .mockResolvedValueOnce({ archived: true });
    const client = new ConversationRpcClient({
      requestReady,
    } as unknown as JsonlClient);

    await expect(client.forkThread(THREAD_A)).rejects.toThrow(
      'Invalid Turn',
    );
    await expect(client.archiveThread(THREAD_A)).rejects.toThrow(
      'Invalid thread/archive response',
    );
  });
});
