import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { sanitizeConnectorError } from "../integrations/connector-safety.js";

/**
 * A tool served over MCP: the contract a client reads, and the handler that
 * answers a call.
 *
 * A handler answers with the MCP result shape: content blocks, and isError for
 * a call that failed. A failure is a result, not a thrown error, so the client
 * reads what went wrong and the turn continues.
 */
export type McpToolDefinition = {
  tool: Tool;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
};

export type McpToolServerOptions = {
  /** The server name a client sees. */
  name: string;
  /** The server version a client sees. */
  version: string;
  /** The tools this server serves. */
  tools: readonly McpToolDefinition[];
  /** Values a failure must never repeat, such as the credential a tool travels with. */
  secrets?: readonly string[];
};

/** A result carrying one JSON payload as its text content. */
export function mcpTextResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * An MCP server that serves one set of tools.
 *
 * The server holds no credential and no state of its own: a handler is given
 * the arguments the call carried and returns the answer. Anything a handler
 * needs beyond its arguments, a credential most of all, is bound into the
 * handler where it is created, so the server never holds one.
 */
export function createMcpToolServer(options: McpToolServerOptions): Server {
  const server = new Server(
    { name: options.name, version: options.version },
    { capabilities: { tools: {} } },
  );
  const handlers = new Map(options.tools.map((entry) => [entry.tool.name, entry.handler]));

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: options.tools.map((entry) => entry.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers.get(request.params.name);
    if (!handler) {
      return mcpTextResult(
        { error: `This server serves no tool named "${request.params.name}".` },
        true,
      );
    }
    try {
      return await handler((request.params.arguments ?? {}) as Record<string, unknown>);
    } catch (error) {
      return mcpTextResult(
        { error: sanitizeConnectorError(error, [...(options.secrets ?? [])]) },
        true,
      );
    }
  });

  return server;
}
