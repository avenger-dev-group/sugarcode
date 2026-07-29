// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { McpActivityTimeline } from '../activity-timeline';

describe('McpActivityTimeline', () => {
  it('shows bounded receipts without raw result content or actions', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
      <McpActivityTimeline
        turnStatus="completed"
        activities={[
          {
            id: 'item/request',
            serverId: 'alpha',
            name: 'mcp__alpha__lookup',
            argumentsBytes: 18,
            argumentsSha256: 'a'.repeat(64),
            inventorySha256: 'b'.repeat(64),
            state: 'succeeded',
            resultId: 'item/result',
            receipt: {
              type: 'completed',
              isError: false,
              observedBytes: 20,
              canonicalBytes: 20,
              retainedBytes: 20,
              truncated: false,
              sha256: 'c'.repeat(64),
              contentBlocks: 1,
              structuredContent: false,
            },
          },
        ]}
      />,
      ),
    );
    expect(container.textContent).toContain('mcp__alpha__lookup');
    expect(container.textContent).toContain('Completed');
    expect(container.textContent).toContain('20 bytes');
    expect(container.querySelector('button')).toBeNull();
    await act(async () => root.unmount());
  });
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

afterEach(() => document.body.replaceChildren());
