import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpToolServer, mcpTextResult } from "./mcp-tool-server.js";

/**
 * The MCP tool server, driven the way a client drives it: over the protocol,
 * with the server and the client joined in memory. No port is opened and
 * nothing leaves the process.
 */

const SECRET = "0123456789abcdef0123456789abcdef";

async function connect(
  tools: Parameters<typeof createMcpToolServer>[0]["tools"],
  secrets?: readonly string[],
) {
  const server = createMcpToolServer({ name: "test-server", version: "1.0.0", tools, secrets });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("MCP tool server", () => {
  it("lists the tools it serves", async () => {
    const { client } = await connect([
      {
        tool: {
          name: "echo",
          description: "Echo a value back",
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        },
        handler: async () => mcpTextResult({ echoed: true }),
      },
    ]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(listed.tools[0]?.description).toBe("Echo a value back");
  });

  it("answers a call with the handler's result", async () => {
    const { client } = await connect([
      {
        tool: {
          name: "echo",
          description: "Echo a value back",
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        },
        handler: async (args) => mcpTextResult({ value: args.value }),
      },
    ]);

    const result = await client.callTool({ name: "echo", arguments: { value: "hello" } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ value: "hello" }) }]);
  });

  it("answers a call for a tool it does not serve with an error result", async () => {
    const { client } = await connect([]);

    const result = await client.callTool({ name: "missing", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("serves no tool named");
  });

  it("turns a failed handler into an error result that carries no secret", async () => {
    const { client } = await connect(
      [
        {
          tool: {
            name: "boom",
            description: "Fails",
            inputSchema: { type: "object", properties: {} },
          },
          handler: async () => {
            throw new Error(`the call carried ${SECRET}`);
          },
        },
      ],
      [SECRET],
    );

    const result = await client.callTool({ name: "boom", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
