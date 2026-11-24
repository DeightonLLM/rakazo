import { ConnectionSetupError } from "@rakazo/contracts";
import type { RemoteUrlPolicy } from "../mcp/remote-mcp.js";
import { verifyCoreDistroApiLeadsCredential } from "../providers/leads/core-distro/core-distro-api-leads.js";
import type { ApiConfig, RemoteConnectorDependencies } from "./installed-connectors.js";

/** What a credential check found: the source accepted it, or it did not and said why. */
export type ApiConnectorPresetCheck = { ok: true } | { ok: false; reason: string };

/**
 * A first-party connector preset: the reviewed description of one installed
 * tool source.
 *
 * A preset is NOT a provider and adds no runtime behaviour. It is the
 * non-secret half of an install — where the source lives, how the credential
 * is presented, and which operations exist — written down once so the same
 * install is not retyped by hand every time and so its contract can be
 * checked here instead of in production.
 *
 * The credential is never part of a preset. It goes through the encrypted
 * credential field of the install, and the config below stays free of it.
 */
export type ApiConnectorPreset = {
  /** Stable id an install records, so a later change to the preset is visible. */
  id: string;
  /** Name a person reads in the integrations list. */
  label: string;
  /** Origin the operation paths are appended to. */
  source: string;
  /** The operations and the auth the install stores. Never a credential. */
  config: ApiConfig;
  /**
   * Asks the source whether a credential works, so an install never keeps a key
   * the service refuses. The check holds the credential only for the call, and
   * the reason it returns never carries it.
   */
  verify?: (
    credential: string,
    options?: {
      signal?: AbortSignal;
      /** How the check reaches the source: the deployment's fetch and address policy. */
      remote?: RemoteConnectorDependencies & RemoteUrlPolicy;
    },
  ) => Promise<ApiConnectorPresetCheck>;
};

/** Where the source below answers. */
const CORE_DISTRO_LEADS_SOURCE = "https://data.core-distro.com";

/**
 * Core Distro's own lead API.
 *
 * The source answers one endpoint, `/api_leads.php`, and dispatches on an
 * `action` query parameter. Each operation below therefore names its action
 * as a single-value enum: the tool schema is the contract, and a tool call
 * whose action is not the one this operation describes is refused before a
 * request is made.
 *
 * The credential is a per-account Core API key. It decides which account's
 * rows the source returns, so this preset sends no account, user or tenant
 * parameter of its own: there is nothing here that could widen what the key
 * may read.
 */
export const CORE_DISTRO_LEADS_PRESET: ApiConnectorPreset = {
  id: "core-distro-leads",
  label: "Core Distro Leads",
  source: CORE_DISTRO_LEADS_SOURCE,
  // The check asks the source itself, through the same tools an agent calls, so
  // a key that cannot read is refused before an install keeps it.
  verify: (credential, options) =>
    verifyCoreDistroApiLeadsCredential(credential, {
      ...options,
      baseUrl: CORE_DISTRO_LEADS_SOURCE,
    }),
  config: {
    auth: { type: "bearer" },
    headers: {},
    operations: [
      {
        id: "core_distro_list_leads",
        name: "core_distro_list_leads",
        description:
          "List the lead lists the connected Core Distro account owns. Returns the list ids, names and lead counts.",
        method: "GET",
        path: "/api_leads.php",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["getLists"],
              description: "Which read to perform. Fixed for this operation.",
            },
            category_group: {
              type: "string",
              description: "Optional category group to narrow the lists by.",
            },
            category: {
              type: "string",
              description: "Optional category to narrow the lists by.",
            },
          },
          required: ["action"],
        },
        readOnly: true,
        queryParameters: ["action", "category_group", "category"],
        headerParameters: [],
      },
      {
        id: "core_distro_get_leads",
        name: "core_distro_get_leads",
        description:
          "Read the leads of one list the connected Core Distro account owns. Paged, and filtered by search text or status.",
        method: "GET",
        path: "/api_leads.php",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["getLeads"],
              description: "Which read to perform. Fixed for this operation.",
            },
            list_id: {
              type: "integer",
              minimum: 1,
              description: "The list to read. Lists of other accounts are not readable.",
            },
            page: {
              type: "integer",
              minimum: 1,
              description: "Page of results, starting at 1.",
            },
            per_page: {
              type: "integer",
              minimum: 10,
              maximum: 200,
              description: "Leads per page. The source accepts 10 to 200.",
            },
            search: {
              type: "string",
              description:
                "Optional text to match against business name, address, phone and notes.",
            },
            status: {
              type: "string",
              enum: ["cold", "warm", "hot"],
              description: "Optional status to narrow the leads by.",
            },
          },
          required: ["action", "list_id"],
        },
        readOnly: true,
        queryParameters: ["action", "list_id", "page", "per_page", "search", "status"],
        headerParameters: [],
      },
    ],
  },
};

/** The first-party presets an operator can install without retyping the operations. */
export const API_CONNECTOR_PRESETS: readonly ApiConnectorPreset[] = [CORE_DISTRO_LEADS_PRESET];

/** The preset with this id, when there is one. */
export function apiConnectorPreset(id: string): ApiConnectorPreset | undefined {
  return API_CONNECTOR_PRESETS.find((preset) => preset.id === id);
}

/**
 * The install request for a preset: what a client sends to install it, with the
 * credential in the encrypted credential field and nowhere else.
 *
 * The result is what the install path accepts; `prepareApiInstall` checks it
 * before anything is stored.
 */
export function apiConnectorPresetInstall(
  id: string,
  credential: string,
): {
  kind: "api";
  name: string;
  source: string;
  config: ApiConfig;
  credential: string;
} {
  const preset = apiConnectorPreset(id);
  if (!preset) throw new ConnectionSetupError(`Unknown connector preset: ${id}`);
  return {
    kind: "api",
    name: preset.label,
    source: preset.source,
    config: preset.config,
    credential,
  };
}
