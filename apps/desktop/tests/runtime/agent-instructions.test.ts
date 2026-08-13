import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hostPlatformInstruction,
  SUGARCODE_BASE_AGENT_PROMPT_V1,
} from '../../src/runtime/agent-instructions.ts';

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
    /pass only entries whose kind is file to workspace_read/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /Skip dependencies, generated output, caches, runtime logs, coverage, temporary\/editor backups/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /Do not inspect secret-bearing files such as .env/u,
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
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /Split large writes into small, independently valid workspace_apply_patch operations/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /A later discovery may justify another request in the same Turn/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /Treat the tool call as an analysis checkpoint/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /without headings, tables, numbered plan sections, or question prompts/u,
  );
  assert.match(
    SUGARCODE_BASE_AGENT_PROMPT_V1,
    /never ask again for a decision the user already confirmed/u,
  );
});

test('host platform instructions prevent Unix-only commands on Windows', () => {
  assert.match(hostPlatformInstruction('win32'), /operating system is Windows/u);
  assert.match(hostPlatformInstruction('win32'), /cat, wc, grep, sed, or touch/u);
  assert.match(hostPlatformInstruction('darwin'), /operating system is macOS/u);
  assert.match(
    hostPlatformInstruction('darwin'),
    /BSD find requires an explicit search path/u,
  );
  assert.match(hostPlatformInstruction('darwin'), /ls is \/bin\/ls/u);
});
