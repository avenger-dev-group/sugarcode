import { describe, expect, it } from 'vitest';

import {
  parseThreadListResponse,
  parseThreadResumeResponse,
} from '../protocol';
import { recoverConversation } from '../recovery';

const approvedReadOnlyCommandItems = () => [
  {
    type: 'toolCall',
    id: 'item_command',
    callId: 'call_command',
    name: 'shell/exec',
    path: '.',
    command: '/usr/bin/true',
    arguments: [] as string[],
  },
  {
    type: 'commandApprovalRequest',
    id: 'item_request',
    approvalId: 'approval_command',
    callId: 'call_command',
    command: '/usr/bin/true',
    arguments: [] as string[],
    cwd: '.',
    environmentPolicy: 'minimalV1',
    sandboxed: true,
    sandboxPolicy: 'filesystemReadOnlyV1',
    networkPolicy: 'networkDeniedV1',
  },
  {
    type: 'commandApprovalDecision',
    id: 'item_decision',
    approvalId: 'approval_command',
    decision: 'approved',
  },
];

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

  it('recovers a workspace list count and discards durable entry names', () => {
    const content = JSON.stringify({
      entries: [
        { name: 'private.txt', kind: 'file' },
        { name: 'nested', kind: 'directory' },
      ],
    });
    const resumed = parseThreadResumeResponse({
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          items: [
            {
              type: 'toolCall',
              id: 'item_0000000000000001',
              callId: 'call_list',
              name: 'workspace/list',
              path: '.',
            },
            {
              type: 'toolResult',
              id: 'item_0000000000000002',
              callId: 'call_list',
              name: 'workspace/list',
              result: {
                type: 'success',
                content,
                bytes: new TextEncoder().encode(content).byteLength,
              },
            },
          ],
        },
      ],
    });

    const recovered = recoverConversation(
      'thr_0000000000000001',
      resumed,
    );
    expect(recovered.turns[0]?.workspaceList).toMatchObject({
      path: '.',
      result: { outcome: { type: 'success', entries: 2 } },
    });
    expect(JSON.stringify(recovered)).not.toContain('private.txt');
    expect(JSON.stringify(recovered)).not.toContain('nested');
  });

  it('recovers a workspace search summary and discards durable matches', () => {
    const content = JSON.stringify({
      matches: [{ path: 'src/private.txt', line: 7 }],
      truncated: false,
    });
    const resumed = parseThreadResumeResponse({
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          items: [
            {
              type: 'toolCall',
              id: 'item_0000000000000010',
              callId: 'call_search',
              name: 'workspace/search',
              path: 'src',
              query: 'needle',
            },
            {
              type: 'toolResult',
              id: 'item_0000000000000011',
              callId: 'call_search',
              name: 'workspace/search',
              result: {
                type: 'success',
                content,
                bytes: new TextEncoder().encode(content).byteLength,
              },
            },
          ],
        },
      ],
    });

    const recovered = recoverConversation(
      'thr_0000000000000001',
      resumed,
    );
    expect(recovered.turns[0]?.workspaceSearch).toMatchObject({
      path: 'src',
      query: 'needle',
      result: {
        outcome: { type: 'success', matches: 1, truncated: false },
      },
    });
    expect(JSON.stringify(recovered)).not.toContain('private.txt');
    expect(JSON.stringify(recovered)).not.toContain('"line"');
  });

  it('recovers a read-only command result summary and discards arguments and output', () => {
    const resumed = parseThreadResumeResponse({
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          items: [
            {
              type: 'toolCall',
              id: 'item_command',
              callId: 'call_command',
              name: 'shell/exec',
              path: '.',
              command: '/usr/bin/printf',
              arguments: ['private-value', '%s'],
            },
            {
              type: 'commandApprovalRequest',
              id: 'item_request',
              approvalId: 'approval_command',
              callId: 'call_command',
              command: '/usr/bin/printf',
              arguments: ['private-value', '%s'],
              cwd: '.',
              environmentPolicy: 'minimalV1',
              sandboxed: true,
              sandboxPolicy: 'filesystemReadOnlyV1',
              networkPolicy: 'networkDeniedV1',
            },
            {
              type: 'commandApprovalDecision',
              id: 'item_decision',
              approvalId: 'approval_command',
              decision: 'approved',
            },
            {
              type: 'commandExecutionAttempt',
              id: 'item_attempt',
              approvalId: 'approval_command',
              callId: 'call_command',
            },
            {
              type: 'toolResult',
              id: 'item_result',
              callId: 'call_command',
              name: 'shell/exec',
              result: {
                type: 'process',
                stdout: 'private-command-output',
                stderr: 'private-command-error',
                stdoutBytes: 22,
                stderrBytes: 21,
                stdoutTruncated: false,
                stderrTruncated: false,
                encoding: 'utf8Lossy',
                durationMs: 1,
                outcome: { type: 'exitCode', code: 0 },
                sandboxPolicy: 'filesystemReadOnlyV1',
                networkPolicy: 'networkDeniedV1',
              },
            },
          ],
        },
      ],
    });

    const recovered = recoverConversation('thr_0000000000000001', resumed);
    expect(recovered.turns[0]?.commandApproval).toEqual({
      callItemId: 'item_command',
      id: 'item_request',
      callId: 'call_command',
      approvalId: 'approval_command',
      command: '/usr/bin/printf',
      argumentCount: 2,
      requestStatus: 'completed',
      decision: {
        id: 'item_decision',
        status: 'completed',
        value: 'approved',
      },
      executionAttempt: {
        id: 'item_attempt',
        status: 'completed',
      },
      executionResult: {
        id: 'item_result',
        status: 'completed',
        outcome: {
          type: 'process',
          stdoutBytes: 22,
          stderrBytes: 21,
          stdoutTruncated: false,
          stderrTruncated: false,
          encoding: 'utf8Lossy',
          durationMs: 1,
          outcome: { type: 'exitCode', code: 0 },
          sandboxPolicy: 'filesystemReadOnlyV1',
          networkPolicy: 'networkDeniedV1',
        },
      },
    });
    expect(JSON.stringify(recovered)).not.toContain('private-value');
    expect(JSON.stringify(recovered)).not.toContain('private-command-output');
    expect(JSON.stringify(recovered)).not.toContain('private-command-error');
  });

  it('rejects a terminal command execution attempt without a result', () => {
    const resumed = parseThreadResumeResponse({
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          items: [
            ...approvedReadOnlyCommandItems(),
            {
              type: 'commandExecutionAttempt',
              id: 'item_attempt',
              approvalId: 'approval_command',
              callId: 'call_command',
            },
          ],
        },
      ],
    });
    expect(() =>
      recoverConversation('thr_0000000000000001', resumed),
    ).toThrow('without a result');
  });

  it('rejects a command execution result before its attempt', () => {
    const resumed = parseThreadResumeResponse({
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          items: [
            ...approvedReadOnlyCommandItems(),
            {
              type: 'toolResult',
              id: 'item_result',
              callId: 'call_command',
              name: 'shell/exec',
              result: { type: 'error', kind: 'spawnFailed' },
            },
          ],
        },
      ],
    });
    expect(() =>
      recoverConversation('thr_0000000000000001', resumed),
    ).toThrow('command execution result');
  });

  it('rejects a shell result that claims workspace-write policy', () => {
    expect(() =>
      parseThreadResumeResponse({
        thread: { id: 'thr_0000000000000001' },
        turns: [
          {
            id: 'turn_0000000000000001',
            status: 'completed',
            items: [
              {
                type: 'toolResult',
                id: 'item_result',
                callId: 'call_command',
                name: 'shell/exec',
                result: {
                  type: 'process',
                  stdout: '',
                  stderr: '',
                  stdoutBytes: 0,
                  stderrBytes: 0,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  encoding: 'utf8Lossy',
                  durationMs: 1,
                  outcome: { type: 'exitCode', code: 0 },
                  sandboxPolicy: 'filesystemReadOnlyV1',
                  workspaceWritePolicy: 'workspaceFilesV1',
                  networkPolicy: 'networkDeniedV1',
                },
              },
            ],
          },
        ],
      }),
    ).toThrow('shell/exec ToolResult outcome');
  });

  it.each([
    {
      label: 'orphan',
      items: [
        {
          type: 'commandExecutionAttempt',
          id: 'item_attempt',
          approvalId: 'approval_command',
          callId: 'call_command',
        },
      ],
    },
    {
      label: 'mismatched',
      items: [
        ...approvedReadOnlyCommandItems(),
        {
          type: 'commandExecutionAttempt',
          id: 'item_attempt',
          approvalId: 'approval_other',
          callId: 'call_command',
        },
      ],
    },
    {
      label: 'duplicate',
      items: [
        ...approvedReadOnlyCommandItems(),
        {
          type: 'commandExecutionAttempt',
          id: 'item_attempt',
          approvalId: 'approval_command',
          callId: 'call_command',
        },
        {
          type: 'commandExecutionAttempt',
          id: 'item_attempt_2',
          approvalId: 'approval_command',
          callId: 'call_command',
        },
      ],
    },
  ])('rejects an $label command execution attempt audit', ({ items }) => {
    const resumed = parseThreadResumeResponse({
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          items,
        },
      ],
    });
    expect(() =>
      recoverConversation('thr_0000000000000001', resumed),
    ).toThrow('command execution attempt');
  });

  it('leaves workspace-write command approvals outside the projection', () => {
    const resumed = parseThreadResumeResponse({
      thread: { id: 'thr_0000000000000001' },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          items: [
            {
              type: 'toolCall',
              id: 'item_command',
              callId: 'call_command',
              name: 'shell/exec',
              path: '.',
              command: '/usr/bin/true',
              arguments: [],
            },
            {
              type: 'commandApprovalRequest',
              id: 'item_request',
              approvalId: 'approval_command',
              callId: 'call_command',
              command: '/usr/bin/true',
              arguments: [],
              cwd: '.',
              environmentPolicy: 'minimalV1',
              sandboxed: true,
              sandboxPolicy: 'filesystemReadOnlyV1',
              workspaceWritePolicy: 'commandWorkspaceWriteV1',
              workspaceWriteRisk: 'nonTransactionalWorkspaceTreeV1',
              networkPolicy: 'networkDeniedV1',
            },
            {
              type: 'commandApprovalDecision',
              id: 'item_decision',
              approvalId: 'approval_command',
              decision: 'approved',
              workspaceWriteRiskAcknowledgement:
                'nonTransactionalWorkspaceTreeV1',
            },
            {
              type: 'commandExecutionAttempt',
              id: 'item_attempt',
              approvalId: 'approval_command',
              callId: 'call_command',
            },
          ],
        },
      ],
    });

    expect(
      recoverConversation('thr_0000000000000001', resumed).turns[0]
        ?.commandApproval,
    ).toBeUndefined();
  });

  it.each([
    {
      data: Array.from({ length: 51 }, (_value, index) => ({
        id: `thr_${String(index).padStart(16, '0')}`,
      })),
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
