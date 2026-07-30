// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ContextCompactionActivity } from '../context-compaction-activity';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

afterEach(() => document.body.replaceChildren());

describe('ContextCompactionActivity', () => {
  it('renders a native collapsible receipt without summary content', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const sourceSha256 = 'a'.repeat(64);
    const summarySha256 = 'b'.repeat(64);

    await act(async () =>
      root.render(
        <ContextCompactionActivity
          activity={{
            id: 'item_0000000000000001',
            ordinal: 2,
            state: 'completed',
            preContextBytes: 3_200_000,
            sourceMessages: 18,
            sourceBytes: 2_900_000,
            sourceSha256,
            postContextBytes: 900_000,
            summaryBytes: 512,
            summarySha256,
          }}
        />,
      ),
    );

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.getAttribute('aria-label')).toBe('Context compacted');
    expect(container.textContent).toContain('modelGeneratedActiveTurnV1');
    expect(container.textContent).toContain('Source messages18');
    expect(container.textContent).toContain('Summary bytes512 bytes');
    expect(container.textContent).toContain(sourceSha256);
    expect(container.textContent).toContain(summarySha256);
    expect(container.textContent).not.toContain('private checkpoint text');

    await act(async () => root.unmount());
  });
});
