import { describe, expect, it, vi } from "vitest";
import { verifyCoreDistroApiLeadsCredential } from "./core-distro-api-leads.js";

/**
 * The credential check an install runs before it keeps a key, checked against
 * the source it will really call.
 *
 * Everything here is offline. The source is a stub, the key is a placeholder
 * that exists in this file only, and the check never leaves the process.
 */

const CREDENTIAL = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** The source is public, so the address policy is satisfied by this answer. */
const PUBLIC_NETWORK = {
  resolveHostname: async () => [{ address: "93.184.216.34", family: 4 as const }],
};

function answered(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("the Core Distro credential check", () => {
  it("accepts a key the source answers", async () => {
    const fetch = answered({ success: true, lists: [{ id: 17, name: "Dentists", lead_count: 2 }] });

    const check = await verifyCoreDistroApiLeadsCredential(CREDENTIAL, {
      remote: { fetch: fetch as never, ...PUBLIC_NETWORK },
    });

    expect(check).toEqual({ ok: true });
  });

  it("refuses a key the source rejects, and says why without the key", async () => {
    const fetch = answered({ success: false, error: "Invalid API key" }, 401);

    const check = await verifyCoreDistroApiLeadsCredential(CREDENTIAL, {
      remote: { fetch: fetch as never, ...PUBLIC_NETWORK },
    });

    expect(check.ok).toBe(false);
    expect(JSON.stringify(check)).not.toContain(CREDENTIAL);
  });

  it("carries the key in one header and never in the address", async () => {
    const fetch = answered({ success: true, lists: [] });

    await verifyCoreDistroApiLeadsCredential(CREDENTIAL, {
      remote: { fetch: fetch as never, ...PUBLIC_NETWORK },
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
    expect(String(url)).not.toContain(CREDENTIAL);
  });

  it("answers with a refusal when the source cannot be reached", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("network is down"));

    const check = await verifyCoreDistroApiLeadsCredential(CREDENTIAL, {
      remote: { fetch: fetch as never, ...PUBLIC_NETWORK },
    });

    expect(check.ok).toBe(false);
    expect(JSON.stringify(check)).not.toContain(CREDENTIAL);
  });
});
