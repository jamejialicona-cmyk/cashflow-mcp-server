#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME } from "./server.js";

/**
 * cashflow-mcp-server
 *
 * Exposes a deterministic project cash flow engine over MCP. Every tool is a
 * pure computation: no network, no filesystem, no clock, no state between
 * calls. That is why all of them are annotated read-only and idempotent, and
 * why an agent can retry any call freely.
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs to the protocol. Anything a human should read goes to
  // stderr, or it corrupts the JSON-RPC stream.
  console.error(`${SERVER_NAME} listening on stdio`);
}

main().catch((error: unknown) => {
  console.error(`Fatal error starting ${SERVER_NAME}:`, error);
  process.exit(1);
});
