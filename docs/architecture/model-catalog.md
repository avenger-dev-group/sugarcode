# Model catalog and Turn selection

Model configuration is provider-neutral durable v3 SQLite state. A connection
selects `openaiResponses`, `openaiChatCompletions` or `anthropicMessages` and
stores a base URL, optional bounded custom headers and credential status. A
profile selects a connection, model ID, timeout and parallel-tool preference.

Credentials are stored separately from public inspection results. They never
enter Renderer state, runtime events, logs, approval presentation or model
history. Configuration writes are revision-guarded and atomic.

Discovery uses the matching official SDK against the selected connection and
does not mutate configuration. Compatible gateways are supported only through
the OpenAI wire families and the explicit normalization boundary.

A Turn freezes its resolved connection/profile before provider I/O. Changing a
profile affects the next Turn, not an active one. Missing credentials, invalid
URLs, unsupported capability combinations and discovery failures remain typed
configuration outcomes; they do not prevent workspace or Thread history from
opening.

SugarCode advertises only tools supported by the current local authority and
runtime state. Model capability hints constrain requests but never authorize a
filesystem, process, Git or MCP action.
