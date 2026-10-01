# Decisions: MCP host-connector guard

Unit: stop pi's `MCP server "nan-media" is registered, but no loaded extension
connects MCP servers` error and replace it with actionable guidance when the
host loads no built-in `mcp` extension (PI WEB sessions).

## Test file path-protection records

```text
path-protection-records@1
kind | paths | phase | date | authority | justification
justification | test/mcp-host-connector.test.ts | P1 | 2026-09-30 | execute-phase | New test file written first against the host-connector guard contract (detect the built-in /mcp command, claim mcp_servers_change + warn when it is missing, stay silent when it is loaded or nothing is registered, gate /nan-mcp status and enable). Justification: the behavior did not exist before this unit, so the tests define it before the implementation (AGENTS.md: tests before implementation)
```

## Decisions

- **Root cause is host-side, not package-side**: pi-web builds its sessions via
  `createAgentSessionServices` → `new DefaultResourceLoader(...)` without
  `extensionFactories`, so NO `builtin:*` extension loads — including
  `builtin:mcp`, which connects `pi.registerMcpServer()` registrations and
  registers `/mcp`. Verified on pi 0.99.1 (`~/.bun/install/global`) with a
  faithful loader run: packages load, `builtin:mcp` absent, `nan-media`
  registered, `reportUnhandledMcpServers()` then fires right after the
  `session_start` emit (`AgentSession.bindExtensions`).
- **Detection signal = the `/mcp` command**: the built-in MCP extension always
  registers it, and pi's own replacement contract is phrased in those terms
  ("an extension that registers `/mcp` ... replaces the built-in one").
  `pi.getCommands()` missing (older pi, minimal mocks) → conservative `true`,
  so existing tests and pi <0.99 behavior are untouched.
- **Claim, don't unregister**: unregistering one server at a time still makes
  pi's report fire over the ones that remain registered, so the guard claims
  `mcp_servers_change` (pi's signal that a connector exists) and sends its own
  message instead. The claim is released by a later `session_start` that finds
  a connector.
- **`/nan-mcp enable` persists but does not register without a connector**:
  registering would only re-trigger pi's error; the toggle applies as soon as
  `builtin:mcp` loads.
