import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import { ConnectionStatusView } from './connection-status';
import { toConnectionViewModel } from './use-store';

describe('ConnectionStatusView', () => {
  it.each([
    ['idle', 'Idle'],
    ['connecting', 'Connecting'],
    ['ready', 'Ready'],
    ['failed', 'Connection failed'],
    ['closed', 'Closed'],
  ] as const)('renders the real %s state', (status, label) => {
    const connection = toConnectionViewModel({
      revision: 1,
      status,
    });
    const markup = renderToStaticMarkup(
      <ConnectionStatusView connection={connection} />,
    );

    expect(markup).toContain(label);
    expect(markup).toContain(`Local runtime: ${label}`);
    expect(markup).toContain('CLI / JSONL');
  });

  it('renders only the safe diagnostic summary for failures', () => {
    const connection = toConnectionViewModel({
      revision: 2,
      status: 'failed',
      diagnostic: {
        code: 'spawn-failed',
        summary: 'SugarCode could not start its local CLI.',
      },
    });
    const markup = renderToStaticMarkup(
      <ConnectionStatusView connection={connection} />,
    );

    expect(markup).toContain('SugarCode could not start its local CLI.');
    expect(markup).toContain('role="alert"');
  });
});
