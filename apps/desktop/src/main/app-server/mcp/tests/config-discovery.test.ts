import { describe, expect, it } from 'vitest';

import { parseMcpServerInventory } from '../config-discovery';

describe('MCP configuration discovery', () => {
  it('accepts only a sorted redacted inventory', () => {
    expect(
      parseMcpServerInventory({
        servers: [
          { id: 'alpha', transport: 'stdio' },
          { id: 'beta', transport: 'stdio' },
        ],
      }),
    ).toEqual([
      { id: 'alpha', transport: 'stdio' },
      { id: 'beta', transport: 'stdio' },
    ]);
    expect(() =>
      parseMcpServerInventory({
        servers: [
          { id: 'beta', transport: 'stdio' },
          { id: 'alpha', transport: 'stdio' },
        ],
      }),
    ).toThrow('not sorted');
    expect(() =>
      parseMcpServerInventory({
        servers: [
          {
            id: 'alpha',
            transport: 'stdio',
            executable: '/private/tool',
          },
        ],
      }),
    ).toThrow('Invalid MCP server inventory');
  });
});
