import { describe, expect, it } from 'vitest';

import { parseThreadResumeResponse } from '../protocol';
import { recoverConversation } from '../recovery';

describe('MCP conversation recovery', () => {
  it('recovers five durable MCP Items without exposing arguments or content', () => {
    const snapshot = parseThreadResumeResponse({
      thread: { id: 'thread/1' },
      turns: [
        {
          id: 'turn/1',
          status: 'completed',
          items: [
            {
              type: 'mcpToolCall',
              id: 'item/call',
              callId: 'call/1',
              name: 'mcp__alpha__lookup',
              arguments: { query: 'private-search' },
              argumentsBytes: 26,
              argumentsSha256: 'a'.repeat(64),
              inventorySha256: 'b'.repeat(64),
            },
            {
              type: 'mcpToolCallApprovalRequest',
              id: 'item/request',
              approvalId: 'approval/1',
              callId: 'call/1',
              name: 'mcp__alpha__lookup',
              arguments: { query: 'private-search' },
              argumentsBytes: 26,
              argumentsSha256: 'a'.repeat(64),
              inventorySha256: 'b'.repeat(64),
            },
            {
              type: 'mcpToolCallApprovalDecision',
              id: 'item/decision',
              approvalId: 'approval/1',
              decision: 'approved',
            },
            {
              type: 'mcpToolExecutionAttempt',
              id: 'item/attempt',
              approvalId: 'approval/1',
              callId: 'call/1',
              inventorySha256: 'b'.repeat(64),
            },
            {
              type: 'mcpToolResult',
              id: 'item/result',
              callId: 'call/1',
              name: 'mcp__alpha__lookup',
              result: {
                type: 'completed',
                content: 'secret-result',
                is_error: false,
                observed_bytes: 13,
                canonical_bytes: 13,
                retained_bytes: 13,
                truncated: false,
                sha256: 'c'.repeat(64),
                content_blocks: 1,
                structured_content: false,
              },
            },
          ],
        },
      ],
    });
    const recovered = recoverConversation('thread/1', snapshot);
    expect(recovered.turns[0]?.mcpActivities).toEqual([
      expect.objectContaining({
        serverId: 'alpha',
        name: 'mcp__alpha__lookup',
        argumentsBytes: 26,
        result: expect.objectContaining({
          receipt: expect.objectContaining({
            type: 'completed',
            retainedBytes: 13,
          }),
        }),
      }),
    ]);
    const serialized = JSON.stringify(recovered);
    expect(serialized).not.toContain('private-search');
    expect(serialized).not.toContain('secret-result');
  });
});
