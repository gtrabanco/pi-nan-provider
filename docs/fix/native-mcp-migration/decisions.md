# Decisions: Native MCP Migration

## Test file path-protection justifications

justification | test/mcp-search.test.ts | P1 | 2026-09-29 | execute-phase | Rewrite from ToolDefinition-wrapper tests (callNanMcpTool, createNanWebSearchTool) to native MCP registration tests (registerMcpServer config, guard absent). Justification: the registerTool bridge is deleted; tests now verify the exact server config passed to pi.registerMcpServer, gate resolution, and the missing-API-key guard.

justification | test/mcp-media.test.ts | P2 | 2026-09-29 | execute-phase | Rewrite from ToolDefinition-wrapper tests (callStdioMcpTool, defineMediaTool) to native MCP registration tests (registerMcpServer stdio config, version pin, timeout conversion). Justification: the stdio client is deleted; tests now verify the stdio server config (command, args, timeout in seconds, exposure: direct) and gate resolution.

justification | test/nan-mcp-command.test.ts | P3 | 2026-09-29 | execute-phase | Rewrite from registerTool-callback tests to native MCP registration tests. Justification: the command now calls pi.registerMcpServer / pi.unregisterMcpServer directly instead of callbacks; enable/disable immediately registers/unregisters; status reads pi.getMcpServers(). Tests updated to match the new contract (tools hidden immediately on disable, not "remain until restart").

justification | test/compat.test.ts | P4 | 2026-09-29 | execute-phase | Rewrite from registerTool-wrapper tests to native MCP server tests. Justification: MCP no longer uses registerTool; tests now verify registerMcpServer calls (2 servers on modern pi, 0 on pi<0.99, gate resolution, persisted disable). Added withoutRegisterMcpServer option and mcpServers tracking to RecordedRegistration.
## Final verification

Justification | docs/fix/native-mcp-migration/decisions.md | P5 | 2026-09-29 | execute-phase | Path-protection justification for this entire native-MCP migration unit. All test files rewritten from ToolDefinition-wrapper to native registration tests. Gate green: 207/207 pass, typecheck clean, check-pi-sdk-versions exit 0.

## Verified Facts

- **Connection timing**: Eager at registration time (not per-call). The native MCP extension in pi 0.99.0 connects servers "when a session starts, and servers registered later right away" (docs/mcp.md in tarball). The old stdio client spawned per call — this is a real resource-behavior change documented in the changelog.
- **Timeout units**: Seconds (not ms). The tarball docs say "timeout: 60" (default). The native config `timeout` is in seconds. Conversion: mediaMcpTimeoutMs() → mediaMcpTimeoutSec() = Math.ceil(ms/1000). Default 120,000ms → 120s.
- **Unregister removes tools**: `pi.unregisterMcpServer()` removes the server from the registry, the MCP extension disconnects it, and tools become hidden (not unregistered from pi's tool table, but unreachable). This is a different behavior from the old registerTool/unregisterTool bridge where tools were fully unregistered.
- **`exposure: "direct"`**: Both servers use explicit `exposure: "direct"` to preserve the existing behavior of tools being declared to the model (unlike the default `codemode` which hides them from the model).

## Test Expectations Retargeted

1. `test/compat.test.ts`: registerTool-wrapper → registerMcpServer calls (2 servers on modern pi, 0 on pi<0.99, gate resolution). Added withoutRegisterMcpServer option.
2. `test/mcp-search.test.ts`: callNanMcpTool/createNanWebSearchTool → registerMcpServer config assertions. No registry resolution at registration time (process.env only). Console.warn instead of ui.notify.
3. `test/mcp-media.test.ts`: callStdioMcpTool/defineMediaTool → registerMcpServer stdio config assertions. stdio client deleted. Timeout in seconds (120 not 120000).
4. `test/nan-mcp-command.test.ts`: registerTool-callback → registerMcpServer/unregisterMcpServer direct calls. enable/disable now immediately register/unregister. Status reads pi.getMcpServers().
5. `test/check-nan-mcp-server.test.ts`: Updated imports to use local bridgedtools constant.
