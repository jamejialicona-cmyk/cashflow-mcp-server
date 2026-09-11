import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContractTools } from "./tools/contract.js";
import { registerPrimitiveTools } from "./tools/primitives.js";
import { registerReferenceTools } from "./tools/reference.js";

export const SERVER_NAME = "cashflow-mcp-server";
export const SERVER_VERSION = "0.1.0";

/**
 * Builds the server with every tool registered.
 *
 * Separated from the stdio entry point so tests can connect an in-memory
 * transport to the same server the binary serves. A test that exercises a
 * different object than production is not a test of production.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerReferenceTools(server);
  registerContractTools(server);
  registerPrimitiveTools(server);

  return server;
}
