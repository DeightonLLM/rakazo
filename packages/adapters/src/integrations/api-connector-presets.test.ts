import { describe, expect, it, vi } from "vitest";
import { parseConnectorToolArgs } from "../tools/lazy-tool-catalog.js";
import {
  API_CONNECTOR_PRESETS,
  apiConnectorPreset,
  apiConnectorPresetInstall,
  CORE_DISTRO_LEADS_PRESET,
} from "./api-connector-presets.js";
import {
  ApiConfigSchema,
  InstalledConnectorProvider,
  prepareApiInstall,
} from "./installed-connectors.js";

/**
 * The Core Distro connector preset, checked against the paths Rakazo actually
 * uses: the install that stores it, the tools it becomes, the request it
 * makes, and the refusals it turns into.
 *
 * Everything here is offline. The hostname is resolved by a stub, the request
 * is answered by a stub, and the credential is a placeholder that exists in
 * this file only.
 */

const CREDENTIAL = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** The documented public address of the source. The policy is exercised with it. */
const PUBLIC_NETWORK = {
  resolveHostname: async () => [{ address: "93.184.216.34", family: 4 as const }],
};

const PRIVATE_NETWORK = {
  resolveHostname: async () => [{ address: "127.0.0.1", family: 4 as const }],
};

const context = {
  operationId: "core-distro-preset-test",
  traceId: "core-distro-preset-test",
  spaceId: "space-1",
  userId: "user-1",
  signal: AbortSignal.timeout(5_000),
} as never;

function fakeInstall(config: unknown = CORE_DISTRO_LEADS_PRESET.config) {
  return {
    id: "install-core-distro",
    kind: "api",
    name: CORE_DISTRO_LEADS_PRESET.label,
    source: CORE_DISTRO_LEADS_PRESET.source,
    secretId: "secret-core-distro",
    createdAt: new Date(0),
    config,
  };
}

function fakePrisma(install: ReturnType<typeof fakeInstall>) {
  return {
    capabilityInstall: {
      findMany: vi.fn().mockResolvedValue([install]),
      findFirst: vi.fn().mockResolvedValue(install),
    },
    secret: {
      findFirst: vi.fn().mockResolvedValue({ id: "secret-core-distro", ciphertext: "ciphertext" }),
    },
  };
}

const fakeSecrets = { load: vi.fn().mockResolvedValue(CREDENTIAL) };

function providerWith(fetch: typeof globalThis.fetch, install = fakeInstall()) {
  return new InstalledConnectorProvider(fakePrisma(install) as never, fakeSecrets as never, {
    fetch,
    ...PUBLIC_NETWORK,
  });
}

async function callTool(
  provider: InstalledConnectorProvider,
  toolName: string,
  args: Record<string, unknown>,
) {
  const events = [];
  for await (const event of provider.execute(
    {
      tool: toolName,
      args,
      executionId: toolName,
      route: { connectorId: "installed", resourceId: "install-core-distro", toolName },
    },
    context,
  )) {
    events.push(event);
  }
  return events;
}

describe("Core Distro connector preset", () => {
  it("is one of the first-party presets and is found by its id", () => {
    expect(API_CONNECTOR_PRESETS).toContain(CORE_DISTRO_LEADS_PRESET);
    expect(apiConnectorPreset("core-distro-leads")).toBe(CORE_DISTRO_LEADS_PRESET);
    expect(apiConnectorPreset("not-a-preset")).toBeUndefined();
  });

  it("turns into an install request the install path accepts", async () => {
    const request = apiConnectorPresetInstall("core-distro-leads", CREDENTIAL);
    expect(request.kind).toBe("api");
    expect(request.name).toBe(CORE_DISTRO_LEADS_PRESET.label);
    expect(request.source).toBe("https://data.core-distro.com");
    expect(request.credential).toBe(CREDENTIAL);

    const prepared = await prepareApiInstall({
      source: request.source,
      config: request.config,
      credential: request.credential,
      remote: { fetch: vi.fn(), ...PUBLIC_NETWORK },
    });
    expect(prepared.operationCount).toBe(2);
    // The credential is the only secret in the request, and it is not in the config.
    expect(JSON.stringify(request.config)).not.toContain(CREDENTIAL);
  });

  it("refuses an install request for a preset that does not exist", () => {
    expect(() => apiConnectorPresetInstall("not-a-preset", CREDENTIAL)).toThrow();
  });

  it("installs through the real install path, with no OpenAPI document to fetch", async () => {
    const fetch = vi.fn();
    const prepared = await prepareApiInstall({
      source: CORE_DISTRO_LEADS_PRESET.source,
      config: CORE_DISTRO_LEADS_PRESET.config,
      credential: CREDENTIAL,
      remote: { fetch, ...PUBLIC_NETWORK },
    });

    expect(prepared.source).toBe("https://data.core-distro.com");
    expect(prepared.operationCount).toBe(2);
    const installed = ApiConfigSchema.parse(prepared.config);
    expect(installed.auth).toEqual({ type: "bearer" });
    expect(installed.operations.map((operation) => operation.id)).toEqual([
      "core_distro_list_leads",
      "core_distro_get_leads",
    ]);
    // Nothing was fetched: the preset carries its operations.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the credential out of the stored configuration", async () => {
    const prepared = await prepareApiInstall({
      source: CORE_DISTRO_LEADS_PRESET.source,
      config: CORE_DISTRO_LEADS_PRESET.config,
      credential: CREDENTIAL,
      remote: { fetch: vi.fn(), ...PUBLIC_NETWORK },
    });

    expect(JSON.stringify(prepared.config)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(prepared.config)).not.toContain("authorization");
  });

  it("is a public source, so no private-endpoint escape is needed", async () => {
    await expect(
      prepareApiInstall({
        source: CORE_DISTRO_LEADS_PRESET.source,
        config: CORE_DISTRO_LEADS_PRESET.config,
        credential: CREDENTIAL,
        remote: { fetch: vi.fn(), ...PUBLIC_NETWORK },
      }),
    ).resolves.toBeTruthy();

    // The same install against a private address is refused, so the pass above
    // is the host policy working and not the policy being absent.
    await expect(
      prepareApiInstall({
        source: CORE_DISTRO_LEADS_PRESET.source,
        config: CORE_DISTRO_LEADS_PRESET.config,
        credential: CREDENTIAL,
        remote: { fetch: vi.fn(), ...PRIVATE_NETWORK },
      }),
    ).rejects.toThrow();
  });

  it("becomes read-only tools", async () => {
    const provider = providerWith(vi.fn());
    const tools = await provider.discoverTools(context);

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "core_distro_get_leads",
      "core_distro_list_leads",
    ]);
    for (const tool of tools) {
      expect(tool.readOnly).toBe(true);
    }
  });

  it("sends the credential as a bearer header and asks for the lists", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ success: true, lists: [{ id: 1, name: "Alpha" }] }));
    const provider = providerWith(fetch as never);
    const events = await callTool(provider, "core_distro_list_leads", { action: "getLists" });

    expect(events).toContainEqual({
      type: "result",
      data: { status: 200, data: { success: true, lists: [{ id: 1, name: "Alpha" }] } },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://data.core-distro.com/api_leads.php?action=getLists");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
    // The credential travels in one header, and nowhere else.
    const carriers = [...headers.entries()].filter(([, value]) => value.includes(CREDENTIAL));
    expect(carriers.map(([name]) => name)).toEqual(["authorization"]);
  });

  it("sends the reads it was given and nothing it was not", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ success: true, leads: [] }));
    const provider = providerWith(fetch as never);
    await callTool(provider, "core_distro_get_leads", {
      action: "getLeads",
      list_id: 1001,
      page: 2,
      per_page: 25,
      search: "acme",
      status: "hot",
    });

    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://data.core-distro.com/api_leads.php");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      action: "getLeads",
      list_id: "1001",
      page: "2",
      per_page: "25",
      search: "acme",
      status: "hot",
    });
  });

  it("carries no account, user or tenant selector, so the key decides the account", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ success: true, leads: [] }));
    const provider = providerWith(fetch as never);
    await callTool(provider, "core_distro_get_leads", { action: "getLeads", list_id: 1001 });

    const url = new URL(String(fetch.mock.calls[0]![0]));
    const forbidden = [
      "user_id",
      "userid",
      "space_id",
      "spaceid",
      "tenant",
      "account",
      "account_id",
    ];
    for (const name of url.searchParams.keys()) {
      expect(forbidden).not.toContain(name.toLowerCase());
    }
    // The only identity on the wire is the credential in the header.
    expect(url.searchParams.toString()).not.toContain(CREDENTIAL);
  });

  it("refuses a tool call that asks for another action", () => {
    const listOperation = CORE_DISTRO_LEADS_PRESET.config.operations[0]!;
    const leadsOperation = CORE_DISTRO_LEADS_PRESET.config.operations[1]!;

    expect(() =>
      parseConnectorToolArgs(listOperation.inputSchema, { action: "getLeads" }),
    ).toThrow();
    expect(() =>
      parseConnectorToolArgs(leadsOperation.inputSchema, { action: "getLists", list_id: 1 }),
    ).toThrow();
    expect(parseConnectorToolArgs(listOperation.inputSchema, { action: "getLists" })).toEqual({
      action: "getLists",
    });
    expect(
      parseConnectorToolArgs(leadsOperation.inputSchema, { action: "getLeads", list_id: 1001 }),
    ).toEqual({ action: "getLeads", list_id: 1001 });
  });

  it("turns a refused credential into a result that carries no key", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { success: false, error: "Invalid API key", echoed: CREDENTIAL },
          { status: 401 },
        ),
      );
    const provider = providerWith(fetch as never);
    const events = await callTool(provider, "core_distro_list_leads", { action: "getLists" });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(CREDENTIAL);
    expect(events).toContainEqual({
      type: "result",
      data: {
        error: true,
        status: 401,
        data: { success: false, error: "Invalid API key", echoed: "[redacted]" },
      },
    });
  });

  it("turns a throttled source into a result that carries the status", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ success: false, error: "Rate limit exceeded" }, { status: 429 }),
      );
    const provider = providerWith(fetch as never);
    const events = await callTool(provider, "core_distro_list_leads", { action: "getLists" });

    expect(events).toContainEqual({
      type: "result",
      data: {
        error: true,
        status: 429,
        data: { success: false, error: "Rate limit exceeded" },
      },
    });
  });

  it("keeps the operation ids, methods and paths stable", () => {
    expect(
      CORE_DISTRO_LEADS_PRESET.config.operations.map((operation) => [
        operation.id,
        operation.method,
        operation.path,
        operation.readOnly,
      ]),
    ).toEqual([
      ["core_distro_list_leads", "GET", "/api_leads.php", true],
      ["core_distro_get_leads", "GET", "/api_leads.php", true],
    ]);
  });
});
