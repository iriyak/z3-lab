// Standalone stdio MCP server exposing only the `z3` tool (for MCP Inspector / quick tests).
//   bun run mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerZ3Tool } from "./z3-tool";

const server = new McpServer({ name: "z3-lab", version: "0.1.0" });
registerZ3Tool(server);
await server.connect(new StdioServerTransport());
