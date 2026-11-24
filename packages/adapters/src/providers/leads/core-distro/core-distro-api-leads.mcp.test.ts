import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createCoreDistroApiLeadsMcpServer } from "./core-distro-api-leads.js";

/**
 * The Core Distro api_leads wrapper, driven as an MCP server: a client lists
 * the tools over the protocol and calls one, and the wrapper answers the
 * source behind it.
 *
 * Everything is offline. The source is a stub, the key is a placeholder that
 * exists in this file only, and the client and the server are joined in
 * memory.
 */

const CREDENTIAL = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function connect(fetch: typeof globalThis.fetch) {
  const server = createCoreDistroApiLeadsMcpServer({ credential: CREDENTIAL, fetch });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("Core Distro api_leads over MCP", () => {
  it("serves the two lead reads to a client that lists its tools", async () => {
    const client = await connect(vi.fn() as never);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "core_distro_list_leads",
      "core_distro_get_leads",
    ]);
    expect(listed.tools[0]?.inputSchema.type).toBe("object");
  });

  it("answers a call with the lists the source returned", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          lists: [{ id: 17, name: "Dentists, Leeds", lead_count: 42 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = await connect(fetch as never);

    const result = (await client.callTool({
      name: "core_distro_list_leads",
      arguments: { action: "getLists" },
    })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const text = result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : "";
    expect(JSON.parse(text)).toEqual({
      lists: [
        {
          id: 17,
          name: "Dentists, Leeds",
          lead_count: 42,
        },
      ],
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
    expect(new URL(String(url)).searchParams.get("action")).toBe("getLists");
  });

  it("answers a call whose key was refused with an error result that carries no key", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "Invalid API key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = await connect(fetch as never);

    const result = await client.callTool({
      name: "core_distro_list_leads",
      arguments: { action: "getLists" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
  });
});
