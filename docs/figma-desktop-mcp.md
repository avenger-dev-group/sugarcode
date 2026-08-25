# Figma Desktop MCP

SugarCode connects directly to the MCP server built into Figma Desktop at:

```text
http://127.0.0.1:3845/mcp
```

This local connection does not use a Figma access token, browser sign-in, or
OAuth. Figma Desktop must remain open while SugarCode uses its tools.

## Enable the server in Figma

1. Open the latest Figma Desktop app and open a Design file.
2. Switch to Dev Mode (`Shift` + `D`).
3. In the MCP server section of the developer panel, enable the desktop MCP
   server.

## Connect SugarCode

1. Open **能力中心 → MCP → 配置服务**.
2. Select **Figma Desktop → 一键添加**.
3. Save the registry.
4. Select `figma-desktop` in the MCP session panel and select **Enable**.

SugarCode discovers the tools exposed by Figma Desktop after the session is
enabled. Each tool call still requires explicit approval in SugarCode.

## MCP tools and Skills are different

The desktop MCP server exposes Figma tools. Skills are separate agent
instructions that describe when and how to combine those tools into a workflow.
Some clients distribute a Figma plugin that bundles an app connection with a
set of Figma-specific Skills; those Skills are not returned by the MCP server.

SugarCode keeps these capabilities separate in **能力中心**:

- **MCP** connects to Figma Desktop and discovers the tools that the running
  server actually exposes.
- **技能** manages compatible `SKILL.md` workflow instructions. A Skill that
  references tools unavailable from the desktop server should not be imported
  unchanged.

SugarCode includes a Figma application entry and three focused Skills that are
enabled by default:

- `$figma` is the application-level entry. It routes the request to the most
  suitable Figma workflow.
- `$figma-selection-context` reads and summarizes the current desktop
  selection or a linked node.
- `$figma-design-to-code` implements a selected design in the current
  codebase while following its components and conventions.
- `$figma-code-connect` creates or maintains Code Connect mappings for real
  code components.

Type `$figma` in the composer to select the application or one of its focused
Skills. Focused Skills may also be loaded automatically when a matching Figma
task clearly requires them. Skills guide the Agent but do not by themselves
claim that a server is connected.

An explicit `$figma` selection automatically activates a configured Figma
Desktop server for that Turn. A Figma URL prefixed with `@` is presented as an
external **链接**, never as a workspace file, and is passed to the Agent as the
target resource identifier.

## Troubleshooting

- Confirm that Figma Desktop is open, a Design file is open, and Dev Mode's
  desktop MCP server is enabled. Opening Figma alone does not start the server.
- Confirm the endpoint is exactly `http://127.0.0.1:3845/mcp`.
- On macOS, verify that Figma is listening locally:

  ```bash
  lsof -nP -iTCP:3845 -sTCP:LISTEN
  ```

- Disable and re-enable the SugarCode MCP session after restarting Figma or
  changing the open Design file.
- Do not use `https://mcp.figma.com/mcp` in this configuration. That endpoint
  is Figma's remote OAuth flow and is outside SugarCode's local MCP scope.
