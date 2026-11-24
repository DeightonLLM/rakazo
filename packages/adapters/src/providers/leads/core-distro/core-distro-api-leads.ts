import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { deadlineSignal, parseRetryAfter } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { z } from "zod";
import { readBoundedText } from "../../../integrations/connector-http.js";
import {
  redactConnectorPayload,
  sanitizeConnectorError,
} from "../../../integrations/connector-safety.js";
import type { RemoteConnectorDependencies } from "../../../integrations/installed-connectors.js";
import type { McpToolDefinition } from "../../../mcp/mcp-tool-server.js";
import { createMcpToolServer, mcpTextResult } from "../../../mcp/mcp-tool-server.js";
import type { RemoteUrlPolicy } from "../../../mcp/remote-mcp.js";
import { createSafeRemoteFetch } from "../../../mcp/remote-mcp.js";

/**
 * Core Distro's own lead API, wrapped as MCP tools.
 *
 * Core answers one endpoint, `/api_leads.php`, and dispatches on an `action`
 * query parameter, with a bearer API key that decides which account's rows a
 * call may read. Two reads are exposed here, one per intent: the lists an
 * account owns, and the leads of one of those lists.
 *
 * WHAT THE WRAPPER GUARANTEES
 *
 *   1. THE CREDENTIAL IS NEVER PART OF THE CONTRACT. The key is an argument of
 *      the call, it travels in one header, and it is never in a URL, in a tool
 *      argument, in a result, or in an error.
 *   2. THE SERVICE DECIDES THE ACCOUNT. The tools carry no account, user or
 *      tenant parameter, so nothing here can widen what the key may read.
 *   3. THE MODEL NEVER SEES THE RAW BODY. A response is parsed and mapped to
 *      the fields below, so an upstream body reaches a model only as the
 *      fields this file names.
 *   4. A REFUSAL IS A RESULT, NOT A CRASH. A rejected key, a locked account,
 *      a throttled key and a malformed answer all come back as an error result
 *      that says what happened.
 */

/** The path the source answers on. */
export const CORE_DISTRO_API_LEADS_PATH = "/api_leads.php";

/** The public address of the source. */
export const CORE_DISTRO_API_LEADS_BASE_URL = "https://data.core-distro.com";

/** One response never carries more than this, so one call cannot fill a context. */
const MAX_RESPONSE_BYTES = 1_000_000;

/** How long one call waits before it is given up on. */
const DEFAULT_TIMEOUT_MS = 15_000;

const listLeadsArguments = z
  .object({
    action: z.literal("getLists"),
    category_group: z.string().trim().min(1).max(120).optional(),
    category: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const getLeadsArguments = z
  .object({
    action: z.literal("getLeads"),
    list_id: z.coerce.number().int().positive(),
    page: z.coerce.number().int().min(1).optional(),
    per_page: z.coerce.number().int().min(10).max(200).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    status: z.string().trim().min(1).max(20).optional(),
  })
  .strict();

/** A number the source may send as a number or as a string. */
const optionalNumber = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((value) =>
    value === null || value === undefined || value === "" ? undefined : Number(value),
  )
  .refine((value) => value === undefined || Number.isFinite(value), "Expected a number");

/** Text the source may send as a string or as nothing at all. */
const optionalText = z.union([z.string(), z.null()]).optional();

const listSummary = z.object({
  id: z.coerce.number().int(),
  name: z.string(),
  description: optionalText,
  category_group: optionalText,
  category: optionalText,
  subcategory: optionalText,
  source: optionalText,
  country: optionalText,
  is_public: optionalNumber,
  lead_count: z.coerce.number().int().default(0),
  created_at: optionalText,
  updated_at: optionalText,
});

const leadSummary = z.object({
  id: z.coerce.number().int(),
  list_id: z.coerce.number().int(),
  business_name: optionalText,
  address: optionalText,
  city: optionalText,
  state: optionalText,
  phone: optionalText,
  website: optionalText,
  rating: optionalNumber,
  review_count: optionalNumber,
  types: optionalText,
  latitude: optionalNumber,
  longitude: optionalNumber,
  emails: z.array(z.string()).catch([]),
  social_media_links: z.array(z.unknown()).catch([]),
  status: z.string().optional(),
  pipeline_stage: optionalText,
  created_at: optionalText,
  updated_at: optionalText,
});

/** The tool schema, without the JSON Schema dialect marker. */
function toolSchema(schema: z.ZodType): Tool["inputSchema"] {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest as Tool["inputSchema"];
}

type ApiLeadsOperation = {
  tool: Tool;
  arguments: z.ZodType;
  /** The query the operation sends, built from the arguments it accepted. */
  query: (args: Record<string, unknown>) => Record<string, string>;
};

const OPERATIONS: readonly ApiLeadsOperation[] = [
  {
    tool: {
      name: "core_distro_list_leads",
      description:
        "List the lead lists the connected Core Distro account owns. Returns each list's id, name and lead count, and can be narrowed by category group or category.",
      inputSchema: toolSchema(listLeadsArguments),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    arguments: listLeadsArguments,
    query: (args) => ({
      action: "getLists",
      ...(args.category_group ? { category_group: String(args.category_group) } : {}),
      ...(args.category ? { category: String(args.category) } : {}),
    }),
  },
  {
    tool: {
      name: "core_distro_get_leads",
      description:
        "Read the leads of one list the connected Core Distro account owns. Paged, and optionally narrowed by search text or by lead status.",
      inputSchema: toolSchema(getLeadsArguments),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    arguments: getLeadsArguments,
    query: (args) => ({
      action: "getLeads",
      list_id: String(args.list_id),
      ...(args.page ? { page: String(args.page) } : {}),
      ...(args.per_page ? { per_page: String(args.per_page) } : {}),
      ...(args.search ? { search: String(args.search) } : {}),
      ...(args.status ? { status: String(args.status) } : {}),
    }),
  },
];

/** The tools this wrapper serves. */
export const CORE_DISTRO_API_LEADS_TOOLS: readonly Tool[] = OPERATIONS.map(
  (operation) => operation.tool,
);

/** What one call needs: the key, and optionally the network it travels over. */
export type CoreDistroApiLeadsContext = {
  /** The per-account API key. It travels in one header and is never stored here. */
  credential: string;
  /** The origin to call. The public address of the source by default. */
  baseUrl?: string;
  /** The fetch to use. The platform one by default. */
  fetch?: typeof globalThis.fetch;
  /** Aborts the call. */
  signal?: AbortSignal;
  /** How long the call waits before it is given up on. */
  timeoutMs?: number;
};

/** The JSON body of a failure, as the service wrote it. */
type ServiceFailure = { error?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the service said, without anything the wrapper must not repeat. */
function failureDetail(body: ServiceFailure, credential: string): string | undefined {
  const detail = typeof body.error === "string" ? body.error : undefined;
  if (!detail) return undefined;
  return redactConnectorPayload(detail, [credential]) as string;
}

/** The sentence a caller reads for a status the source answered with. */
function failureMessage(status: number, retryAfterMs?: number): string {
  switch (status) {
    case 400:
      return "The service rejected the request.";
    case 401:
      return "The service refused the API key. Check that the key is the one this account issued.";
    case 403:
      return "The account behind the API key may not use the API.";
    case 405:
      return "The service does not accept this request method.";
    case 429: {
      const seconds = retryAfterMs === undefined ? undefined : Math.ceil(retryAfterMs / 1000);
      return seconds === undefined
        ? "The service is rate limiting this key. Try again later."
        : `The service is rate limiting this key. Try again in ${seconds} seconds.`;
    }
    default:
      return `The service answered ${status}.`;
  }
}

/** The mapped lists, or undefined when the body is not the shape this file knows. */
function mappedLists(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const lists = payload.lists;
  if (!Array.isArray(lists)) return undefined;
  const parsed = z.array(listSummary).safeParse(lists);
  return parsed.success ? { lists: parsed.data } : undefined;
}

/** The mapped leads and their paging, or undefined when the body is another shape. */
function mappedLeads(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const leads = payload.leads;
  if (!Array.isArray(leads)) return undefined;
  const parsed = z.array(leadSummary).safeParse(leads);
  if (!parsed.success) return undefined;
  return {
    leads: parsed.data,
    total: typeof payload.total === "number" ? payload.total : parsed.data.length,
    page: typeof payload.page === "number" ? payload.page : 1,
    per_page: typeof payload.per_page === "number" ? payload.per_page : parsed.data.length,
    total_pages: typeof payload.total_pages === "number" ? payload.total_pages : 1,
  };
}

/**
 * Call one of the tools.
 *
 * The result is the MCP result shape: the mapped payload as text content, or an
 * error result that says what the service did.
 */
export async function callCoreDistroApiLeadsTool(
  toolName: string,
  args: Record<string, unknown>,
  context: CoreDistroApiLeadsContext,
): Promise<CallToolResult> {
  const operation = OPERATIONS.find((entry) => entry.tool.name === toolName);
  if (!operation) {
    return mcpTextResult({ error: `This client serves no tool named "${toolName}".` }, true);
  }

  const parsed = operation.arguments.safeParse(args);
  if (!parsed.success) {
    return mcpTextResult(
      {
        error: "The tool call did not match the tool's arguments.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      true,
    );
  }

  const url = new URL(
    CORE_DISTRO_API_LEADS_PATH,
    context.baseUrl ?? CORE_DISTRO_API_LEADS_BASE_URL,
  );
  for (const [name, value] of Object.entries(
    operation.query(parsed.data as Record<string, unknown>),
  )) {
    url.searchParams.set(name, value);
  }

  const fetchImpl = context.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${context.credential}`,
        accept: "application/json",
      },
      signal: deadlineSignal(context.timeoutMs ?? DEFAULT_TIMEOUT_MS, context.signal),
      redirect: "error",
    });
  } catch (error) {
    return mcpTextResult({ error: sanitizeConnectorError(error, [context.credential]) }, true);
  }

  const { text } = await readBoundedText(response, MAX_RESPONSE_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return mcpTextResult(
      {
        error: "The service answered with something that was not JSON.",
        status: response.status,
      },
      true,
    );
  }

  if (!isRecord(body)) {
    return mcpTextResult(
      {
        error: "The service answered with a body this client does not read.",
        status: response.status,
      },
      true,
    );
  }

  if (response.status !== 200 || body.success !== true) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    const detail = failureDetail(body, context.credential);
    return mcpTextResult(
      {
        error: failureMessage(response.status, retryAfterMs),
        status: response.status,
        ...(detail ? { detail } : {}),
      },
      true,
    );
  }

  const mapped = toolName === "core_distro_list_leads" ? mappedLists(body) : mappedLeads(body);
  if (!mapped) {
    return mcpTextResult(
      {
        error: "The service answered with a body this client does not read.",
        status: response.status,
      },
      true,
    );
  }

  return mcpTextResult(redactConnectorPayload(mapped, [context.credential]));
}

/** The tools, each bound to the call it makes. */
export function coreDistroApiLeadsTools(context: CoreDistroApiLeadsContext): McpToolDefinition[] {
  return OPERATIONS.map((operation) => ({
    tool: operation.tool,
    handler: (args: Record<string, unknown>) =>
      callCoreDistroApiLeadsTool(operation.tool.name, args, context),
  }));
}

/**
 * An MCP server that serves the Core Distro lead reads.
 *
 * The key is bound into the server's handlers, so the server itself holds it
 * only for as long as the call that uses it.
 */
export function createCoreDistroApiLeadsMcpServer(context: CoreDistroApiLeadsContext) {
  return createMcpToolServer({
    name: "core-distro-api-leads",
    version: "1.0.0",
    tools: coreDistroApiLeadsTools(context),
    secrets: [context.credential],
  });
}

/** What a credential check found. The reason never carries the credential. */
export type CoreDistroApiLeadsCredentialCheck = { ok: true } | { ok: false; reason: string };

/** The sentence a person reads when the source refused a key. */
function credentialRefusalReason(payload: string, credential: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "string" && error.trim()) {
        return redactConnectorPayload(error, [credential]) as string;
      }
    }
  } catch {
    /* A body that is not JSON is reported as the source's own text below. */
  }
  return redactConnectorPayload(payload.slice(0, 500), [credential]) as string;
}

/**
 * Ask the source whether a key works, before an install keeps it.
 *
 * The check runs through the same MCP server an agent calls, so what passes here
 * is the tool contract itself and not a second, weaker copy of it. The key is
 * bound into the server for the length of the call and travels in one header;
 * it never reaches a URL, an argument, a result or the reason this returns.
 */
export async function verifyCoreDistroApiLeadsCredential(
  credential: string,
  options: {
    signal?: AbortSignal;
    /** How the call reaches the source: the deployment's fetch and address policy. */
    remote?: RemoteConnectorDependencies & RemoteUrlPolicy;
    baseUrl?: string;
  } = {},
): Promise<CoreDistroApiLeadsCredentialCheck> {
  // The check is a remote call like any other, so it answers to the same address policy.
  const remote = options.remote;
  const server = createCoreDistroApiLeadsMcpServer({
    credential,
    fetch: remote ? createSafeRemoteFetch(remote.fetch, remote.resolveHostname, remote) : undefined,
    signal: options.signal,
    baseUrl: options.baseUrl,
  });
  const client = new Client({ name: "core-distro-credential-check", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = (await client.callTool({
      name: "core_distro_list_leads",
      arguments: { action: "getLists" },
    })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    if (!result.isError) return { ok: true };
    const text = result.content?.find((entry) => entry.type === "text")?.text ?? "";
    return { ok: false, reason: credentialRefusalReason(text, credential) };
  } catch (error) {
    return { ok: false, reason: sanitizeConnectorError(error, [credential]) };
  } finally {
    await bestEffort("close the credential check client", client.close());
    await bestEffort("close the credential check server", server.close());
  }
}
