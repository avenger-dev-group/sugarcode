// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it } from 'vitest';

import type { CompactToolActivity } from '../types';
import { isCompactToolActivity } from '../tool-activity';
import { ToolActivityGroup } from '../tool-activity-group';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('ToolActivityGroup', () => {
  it('renders resolved commands and MCP calls as compact process rows', async () => {
    const activities: readonly CompactToolActivity[] = [
      {
        type: 'commandApproval',
        activity: {
          id: 'command',
          command: 'pnpm typecheck',
          argumentCount: 1,
          state: 'approved',
          executionAttempt: {
            id: 'attempt',
            state: 'recorded',
          },
          executionResult: {
            id: 'result',
            state: 'recorded',
            outcome: {
              type: 'process',
              stdoutBytes: 32,
              stderrBytes: 0,
              stdoutTruncated: false,
              stderrTruncated: false,
              encoding: 'utf8Lossy',
              durationMs: 540,
              outcome: { type: 'exitCode', code: 0 },
              sandboxPolicy: 'filesystemReadOnlyV1',
              networkPolicy: 'networkDeniedV1',
            },
          },
        },
      },
      {
        type: 'mcp',
        activity: {
          id: 'mcp',
          serverId: 'local',
          name: 'docs/search',
          argumentsBytes: 24,
          argumentsSha256: 'a'.repeat(64),
          inventorySha256: 'b'.repeat(64),
          state: 'succeeded',
        },
      },
    ];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ToolActivityGroup activities={activities} />);
    });

    const group = document.querySelector(
      'details[aria-label="2 tool activities"]',
    );
    expect(group?.hasAttribute('open')).toBe(false);
    expect(group?.textContent).toContain('Ran 1 command and called 1 tool');
    expect(group?.textContent).toContain('pnpm typecheck');
    expect(group?.textContent).toContain('docs/search');
    expect(group?.className).not.toContain('rounded-xl');
    expect(group?.querySelectorAll('[role="status"]')).toHaveLength(2);

    await act(async () => root.unmount());
  });

  it('keeps unresolved approvals outside compact groups', () => {
    expect(
      isCompactToolActivity({
        type: 'commandApproval',
        activity: {
          id: 'command',
          command: 'git status',
          argumentCount: 1,
          state: 'awaiting',
        },
      }),
    ).toBe(false);
    expect(
      isCompactToolActivity({
        type: 'mcp',
        activity: {
          id: 'mcp',
          serverId: 'local',
          name: 'docs/search',
          argumentsBytes: 24,
          argumentsSha256: 'a'.repeat(64),
          inventorySha256: 'b'.repeat(64),
          state: 'awaiting',
        },
      }),
    ).toBe(false);
  });
});
