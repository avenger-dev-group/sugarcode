// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it } from 'vitest';

import { ProcessActivityGroup } from '../process-activity-group';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('ProcessActivityGroup', () => {
  it('starts collapsed and can reveal analysis activity', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ProcessActivityGroup
          groupId="process"
          status="completed"
          requiresAttention={false}
        >
          <p>Analysis details</p>
        </ProcessActivityGroup>,
      );
    });

    const process = document.querySelector(
      'details[aria-label="Processed activity"]',
    ) as HTMLDetailsElement | null;
    expect(process?.open).toBe(false);
    expect(process?.textContent).toContain('Processed');

    await act(async () => {
      if (process) {
        process.open = true;
        process.dispatchEvent(new Event('toggle', { bubbles: false }));
      }
    });
    expect(process?.open).toBe(true);

    await act(async () => root.unmount());
  });

  it('opens automatically when an approval needs attention', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ProcessActivityGroup
          groupId="approval"
          status="inProgress"
          requiresAttention
        >
          <p>Approval request</p>
        </ProcessActivityGroup>,
      );
    });

    const process = document.querySelector(
      'details[aria-label="Action required activity"]',
    ) as HTMLDetailsElement | null;
    expect(process?.open).toBe(true);
    expect(process?.textContent).toContain('Action required');

    await act(async () => root.unmount());
  });
});
