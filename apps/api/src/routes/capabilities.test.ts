import { createRouterClient } from "@orpc/server";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router-test-support.js";

/**
 * The first-party API sources an operator can add, checked at the route: what
 * the server offers, what an install stores, and what a refused key leaves
 * behind.
 *
 * Everything here is offline. The source is a stub, the hostname is resolved
 * by a stub, and the credential is a placeholder that exists in this file only.
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

function presetClient(fetch: typeof globalThis.fetch) {
  const stored: Array<{ id: string; ciphertext: string }> = [];
  const installs: Array<Record<string, unknown>> = [];
  const prisma = {
    secret: { create: vi.fn().mockResolvedValue({}) },
    capabilityInstall: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        installs.push(data);
        return { id: "install-1", ...data, createdAt: new Date(0) };
      }),
    },
  };
  const deps = {
    prisma: {
      ...prisma,
      $transaction: async (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
    } as unknown as PrismaClient,
    secrets: {
      put: vi.fn().mockImplementation(async (value: string) => {
        stored.push({ id: "secret-1", ciphertext: `encrypted:${value}` });
        return { id: "secret-1", ciphertext: `encrypted:${value}` };
      }),
    },
    remoteConnectors: { fetch, ...PUBLIC_NETWORK },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), {
    context: {
      actor: {
        spaceId: "workspace-1",
        userId: "user-1",
        email: "user@rakazo.test",
        isDeploymentOwner: true,
      },
    } as never,
  });
  return { client, stored, installs };
}

describe("capabilities.apiPresets", () => {
  it("offers the first-party sources with their reads and without a credential", async () => {
    const { client } = presetClient(answered({ success: true, lists: [] }));

    const presets = await client.capabilities.apiPresets({});

    expect(presets.length).toBeGreaterThan(0);
    expect(presets[0]).toMatchObject({ id: expect.any(String), label: expect.any(String) });
    expect(presets[0]?.operations[0]?.name).toEqual(expect.any(String));
    expect(JSON.stringify(presets)).not.toContain(CREDENTIAL);
  });
});

describe("capabilities.installApiPreset", () => {
  it("keeps the credential in the encrypted field and never in the stored config", async () => {
    const { client, stored, installs } = presetClient(
      answered({ success: true, lists: [{ id: 1, name: "Lists", lead_count: 0 }] }),
    );

    const install = await client.capabilities.installApiPreset({
      presetId: "core-distro-leads",
      credential: CREDENTIAL,
    });

    expect(install.secretConfigured).toBe(true);
    expect(stored[0]?.ciphertext).toBe(`encrypted:${CREDENTIAL}`);
    const config = installs[0]?.config as Record<string, unknown>;
    expect(JSON.stringify(config)).not.toContain(CREDENTIAL);
    expect(config).toMatchObject({ auth: { type: "bearer" } });
  });

  it("refuses a key the source rejects, and stores nothing", async () => {
    const { client, stored, installs } = presetClient(
      answered({ success: false, error: "Invalid API key" }, 401),
    );

    const failure = await client.capabilities
      .installApiPreset({ presetId: "core-distro-leads", credential: CREDENTIAL })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).not.toBeNull();
    // The refusal is the wrapper's own sentence, and it carries no key.
    expect(String((failure as Error).message)).toContain("refused the API key");
    expect(String((failure as Error).message)).not.toContain(CREDENTIAL);
    expect(stored).toEqual([]);
    expect(installs).toEqual([]);
  });

  it("refuses a preset it does not offer", async () => {
    const { client } = presetClient(answered({ success: true, lists: [] }));

    await expect(
      client.capabilities.installApiPreset({ presetId: "not-a-preset", credential: CREDENTIAL }),
    ).rejects.toThrow();
  });
});
