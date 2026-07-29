import { describe, expect, it } from 'vitest';

import {
  parseThreadListResponse,
  parseThreadResumeResponse,
} from '../protocol';
import { recoverConversation } from '../recovery';

describe('conversation recovery', () => {
  it('parses one latest active Thread and projects text plus workspace read activity', () => {
    const listed = parseThreadListResponse({
      data: [{ id: 'thr_0000000000000002' }],
      nextCursor: 'thr_0000000000000001',
    });
    expect(listed.data).toEqual([{ id: 'thr_0000000000000002' }]);

    const resumed = parseThreadResumeResponse({
      thread: { id: 'thr_0000000000000002' },
      turns: [
        {
          id: 'turn_0000000000000003',
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              id: 'item_0000000000000004',
              text: 'Persist this.',
            },
            {
              type: 'toolCall',
              id: 'item_0000000000000005',
              callId: 'call_1',
              name: 'workspace/read',
              path: 'notes.txt',
            },
            {
              type: 'toolResult',
              id: 'item_0000000000000006',
              callId: 'call_1',
              name: 'workspace/read',
              result: {
                type: 'success',
                content: 'Recovered content.',
                bytes: 18,
              },
            },
            {
              type: 'agentMessage',
              id: 'item_0000000000000007',
              text: 'Recovered answer.',
            },
          ],
        },
        {
          id: 'turn_0000000000000007',
          status: 'failed',
          items: [],
          error: { kind: 'transport', retryable: true },
        },
        {
          id: 'turn_0000000000000008',
          status: 'interrupted',
          items: [],
        },
      ],
    });

    expect(
      recoverConversation('thr_0000000000000002', resumed),
    ).toEqual({
      threadId: 'thr_0000000000000002',
      turns: [
        {
          id: 'turn_0000000000000003',
          status: 'completed',
          messages: [
            {
              id: 'item_0000000000000004',
              role: 'user',
              text: 'Persist this.',
              status: 'completed',
            },
            {
              id: 'item_0000000000000007',
              role: 'agent',
              text: 'Recovered answer.',
              status: 'completed',
            },
          ],
          workspaceRead: {
            id: 'item_0000000000000005',
            callId: 'call_1',
            path: 'notes.txt',
            callStatus: 'completed',
            result: {
              id: 'item_0000000000000006',
              status: 'completed',
              outcome: { type: 'success', bytes: 18 },
            },
          },
        },
        {
          id: 'turn_0000000000000007',
          status: 'failed',
          messages: [],
          error: { kind: 'transport', retryable: true },
        },
        {
          id: 'turn_0000000000000008',
          status: 'interrupted',
          messages: [],
        },
      ],
    });
  });

  it('accepts an empty discovery page', () => {
    expect(
      parseThreadListResponse({ data: [], nextCursor: null }),
    ).toEqual({ data: [], nextCursor: null });
  });

  it('recovers an interrupted workspace read without fabricating a result', () => {
    const resumed = parseThreadResumeResponse({
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'interrupted',
          items: [
            {
              type: 'toolCall',
              id: 'item_0000000000000001',
              callId: 'call_interrupted',
              name: 'workspace/read',
              path: 'pending.txt',
            },
          ],
        },
      ],
    });

    expect(
      recoverConversation('thr_0000000000000001', resumed),
    ).toMatchObject({
      turns: [
        {
          status: 'interrupted',
          workspaceRead: {
            path: 'pending.txt',
            callStatus: 'completed',
          },
        },
      ],
    });
    expect(
      recoverConversation('thr_0000000000000001', resumed).turns[0]
        ?.workspaceRead?.result,
    ).toBeUndefined();
  });

  it.each([
    {
      data: [
        { id: 'thr_0000000000000002' },
        { id: 'thr_0000000000000001' },
      ],
      nextCursor: null,
    },
    { data: [{ id: '' }], nextCursor: null },
    { data: [], nextCursor: 1 },
  ])('rejects an invalid bounded discovery response', (response) => {
    expect(() => parseThreadListResponse(response)).toThrow(
      'Invalid',
    );
  });

  it('rejects mismatched, active and duplicate durable snapshots', () => {
    const active = parseThreadResumeResponse({
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'inProgress',
          items: [],
        },
      ],
    });
    expect(() =>
      recoverConversation('thr_0000000000000001', active),
    ).toThrow('in-progress Turn');
    expect(() =>
      recoverConversation('thr_0000000000000002', {
        threadId: 'thr_0000000000000001',
        turns: [],
      }),
    ).toThrow('another Thread');

    const duplicate = parseThreadResumeResponse({
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              id: 'item_0000000000000001',
              text: 'First.',
            },
            {
              type: 'agentMessage',
              id: 'item_0000000000000001',
              text: 'Duplicate.',
            },
          ],
        },
      ],
    });
    expect(() =>
      recoverConversation('thr_0000000000000001', duplicate),
    ).toThrow('duplicate Item ID');
  });

  it.each([
    {
      thread: { id: 'thr_0000000000000001' },
      turns: {},
    },
    {
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              id: 'item_0000000000000001',
            },
          ],
        },
      ],
    },
    {
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'failed',
          items: [],
        },
      ],
    },
    {
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          items: [],
          error: { kind: 'transport', retryable: true },
        },
      ],
    },
    {
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'failed',
          items: [],
          error: { kind: 'providerSecret', retryable: false },
        },
      ],
    },
  ])('rejects malformed known resume data', (response) => {
    expect(() => parseThreadResumeResponse(response)).toThrow(
      'Invalid',
    );
  });
});
