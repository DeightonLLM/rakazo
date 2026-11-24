import { describe, expect, it, vi } from "vitest";
import {
  CORE_DISTRO_API_LEADS_BASE_URL,
  CORE_DISTRO_API_LEADS_PATH,
  CORE_DISTRO_API_LEADS_TOOLS,
  callCoreDistroApiLeadsTool,
  coreDistroApiLeadsTools,
} from "./core-distro-api-leads.js";

/**
 * The Core Distro api_leads wrapper, checked against the source's contract.
 *
 * Everything here is offline. The request is answered by a stub, the key is a
 * placeholder that exists in this file only, and no address is contacted.
 */

const CREDENTIAL = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const context = (fetch: typeof globalThis.fetch) => ({
  credential: CREDENTIAL,
  fetch,
});

const listsBody = {
  success: true,
  lists: [
    {
      id: 17,
      name: "Dentists, Leeds",
      description: "Leeds dentists",
      category_group: "Healthcare",
      category: "Dentists",
      subcategory: null,
      source: "maps",
      country: "GB",
      is_public: 0,
      lead_count: 42,
      created_at: "2026-10-01 09:00:00",
      updated_at: "2026-11-02 09:00:00",
    },
  ],
};

const leadsBody = {
  success: true,
  leads: [
    {
      id: 900,
      list_id: 17,
      business_name: "Bright Smile",
      address: "1 High Street",
      city: "Leeds",
      state: null,
      phone: "0113 000 0000",
      website: "https://example.invalid",
      rating: "4.50",
      review_count: "12",
      types: "dentist,clinic",
      latitude: "53.80000000",
      longitude: "-1.55000000",
      emails: ["hello@example.invalid"],
      social_media_links: [{ platform: "instagram", url: "https://example.invalid/instagram" }],
      status: "hot",
      pipeline_stage: "new",
      created_at: "2026-10-02 09:00:00",
      updated_at: "2026-11-02 09:00:00",
    },
  ],
  total: 42,
  page: 2,
  per_page: 25,
  total_pages: 2,
  per_page_max: 200,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The payload of a result, parsed from its text content. */
function payloadOf(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content[0]?.text ?? "";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("Core Distro api_leads tools", () => {
  it("serves two read-only tools with a stable name each", () => {
    expect(CORE_DISTRO_API_LEADS_TOOLS.map((tool) => tool.name)).toEqual([
      "core_distro_list_leads",
      "core_distro_get_leads",
    ]);
    for (const tool of CORE_DISTRO_API_LEADS_TOOLS) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description).toBeTruthy();
    }
  });

  it("names the read it performs as a single value, so a call cannot ask for another", async () => {
    const fetch = vi.fn();
    const result = await callCoreDistroApiLeadsTool(
      "core_distro_list_leads",
      { action: "getLeads", list_id: 1 },
      context(fetch as never),
    );

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toBe("The tool call did not match the tool's arguments.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks for the lists and answers with the fields it names", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(listsBody));
    const result = await callCoreDistroApiLeadsTool(
      "core_distro_list_leads",
      { action: "getLists" },
      context(fetch as never),
    );

    expect(result.isError).toBeUndefined();
    const payload = payloadOf(result) as { lists: Array<Record<string, unknown>> };
    expect(payload.lists).toHaveLength(1);
    expect(payload.lists[0]).toMatchObject({
      id: 17,
      name: "Dentists, Leeds",
      lead_count: 42,
      country: "GB",
    });
    // The upstream field names are kept, but nothing the source did not name is passed on.
    expect(Object.keys(payload.lists[0] ?? {}).sort()).toEqual([
      "category",
      "category_group",
      "country",
      "created_at",
      "description",
      "id",
      "is_public",
      "lead_count",
      "name",
      "source",
      "subcategory",
      "updated_at",
    ]);
  });

  it("reads the leads of one list and keeps the paging", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(leadsBody));
    const result = await callCoreDistroApiLeadsTool(
      "core_distro_get_leads",
      { action: "getLeads", list_id: 17, page: 2, per_page: 25, search: "smile", status: "hot" },
      context(fetch as never),
    );

    expect(result.isError).toBeUndefined();
    const payload = payloadOf(result) as {
      leads: Array<Record<string, unknown>>;
      total: number;
      page: number;
      per_page: number;
      total_pages: number;
    };
    expect(payload.total).toBe(42);
    expect(payload.page).toBe(2);
    expect(payload.per_page).toBe(25);
    expect(payload.total_pages).toBe(2);
    expect(payload.leads[0]).toMatchObject({
      id: 900,
      business_name: "Bright Smile",
      rating: 4.5,
      review_count: 12,
      latitude: 53.8,
      emails: ["hello@example.invalid"],
    });
  });

  it("sends the key in one header, and in no other place", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(listsBody));
    await callCoreDistroApiLeadsTool(
      "core_distro_list_leads",
      { action: "getLists" },
      context(fetch as never),
    );

    const [url, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
    const carriers = [...headers.entries()].filter(([, value]) => value.includes(CREDENTIAL));
    expect(carriers.map(([name]) => name)).toEqual(["authorization"]);
    expect(String(url)).not.toContain(CREDENTIAL);
    expect(new URL(String(url)).searchParams.toString()).not.toContain(CREDENTIAL);
  });

  it("calls the source on its own path and asks only for what the tool names", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(leadsBody));
    await callCoreDistroApiLeadsTool(
      "core_distro_get_leads",
      { action: "getLeads", list_id: 17, page: 2, per_page: 25, search: "smile", status: "hot" },
      context(fetch as never),
    );

    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(
      CORE_DISTRO_API_LEADS_BASE_URL + CORE_DISTRO_API_LEADS_PATH,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      action: "getLeads",
      list_id: "17",
      page: "2",
      per_page: "25",
      search: "smile",
      status: "hot",
    });
  });

  it("carries no account, user or tenant selector, so the key decides the account", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(listsBody));
    await callCoreDistroApiLeadsTool(
      "core_distro_list_leads",
      { action: "getLists" },
      context(fetch as never),
    );

    const url = new URL(String(fetch.mock.calls[0]![0]));
    const forbidden = [
      "user_id",
      "userid",
      "space_id",
      "tenant",
      "account",
      "account_id",
      "api_key",
      "key",
    ];
    for (const name of url.searchParams.keys()) {
      expect(forbidden).not.toContain(name.toLowerCase());
    }
  });

  it("turns a refused key into a result that carries no key", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ success: false, error: "Invalid API key", echoed: CREDENTIAL }, 401),
      );
    const result = await callCoreDistroApiLeadsTool(
      "core_distro_list_leads",
      { action: "getLists" },
      context(fetch as never),
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
    const payload = payloadOf(result);
    expect(payload.status).toBe(401);
    expect(payload.error).toContain("refused the API key");
  });

  it("turns a locked account into a result that says so", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ success: false, error: "Account access is restricted" }, 403),
      );
    const result = await callCoreDistroApiLeadsTool(
      "core_distro_list_leads",
      { action: "getLists" },
      context(fetch as never),
    );

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("may not use the API");
  });

  it("turns a throttled key into a result that names how long to wait", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({ success: false, error: "Rate limit exceeded" }, 429, {
        "retry-after": "42",
      }),
    );
    const result = await callCoreDistroApiLeadsTool(
      "core_distro_list_leads",
      { action: "getLists" },
      context(fetch as never),
    );

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("42 seconds");
  });

  it("turns an answer that is not JSON into a result that says so", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("<html>nope</html>", { status: 200 }));
    const result = await callCoreDistroApiLeadsTool(
      "core_distro_list_leads",
      { action: "getLists" },
      context(fetch as never),
    );

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("not JSON");
  });

  it("turns a body of another shape into a result that carries no raw body", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, lists: [{ id: "not-a-number", name: 5 }] }));
    const result = await callCoreDistroApiLeadsTool(
      "core_distro_list_leads",
      { action: "getLists" },
      context(fetch as never),
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("not-a-number");
    expect(payloadOf(result).error).toContain("does not read");
  });

  it("turns a failed request into a result that carries no key", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error(`connect failed for Bearer ${CREDENTIAL}`));
    const result = await callCoreDistroApiLeadsTool(
      "core_distro_list_leads",
      { action: "getLists" },
      context(fetch as never),
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
  });

  it("binds each tool to a call, so a client can be handed the tools alone", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(listsBody));
    const tools = coreDistroApiLeadsTools(context(fetch as never));

    expect(tools.map((entry) => entry.tool.name)).toEqual([
      "core_distro_list_leads",
      "core_distro_get_leads",
    ]);
    const result = await tools[0]!.handler({ action: "getLists" });
    expect(result.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
