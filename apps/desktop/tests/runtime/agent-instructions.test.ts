import assert from 'node:assert/strict';
import test from 'node:test';

import { SUGARCODE_BASE_AGENT_PROMPT_V1 } from '../../src/runtime/agent-instructions.ts';

test('base Agent instructions localize visible output and reject repetitive process narration', () => {
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /original user request for every user-visible progress update/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /do not restate the user's request, narrate every file read, repeat an earlier update/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /workspace_read, provide either one path string or one paths array/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /Inside every `\*\*\* Update File:` operation/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /use one outer `\*\*\* Begin Patch` and `\*\*\* End Patch` pair/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /Never paste an unprefixed complete file body/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /never resubmit the identical failed patch/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /never invent an absolute project path or prepend `cd`/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /future-action promise[\s\S]*is commentary, never a final answer/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /never present an intention to retry as a completed outcome/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /preserve the exact workspace-relative path returned by tools in the Markdown link target/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /Keep the visible label concise/u,
  );
});
