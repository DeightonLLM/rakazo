import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ApiConnectorPreset,
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
  McpSourcePreset,
} from "@rakazo/contracts";
import { Button, Field, FieldDescription, FieldLabel, Input, OptionSelect } from "@rakazo/ui-web";
import { useState } from "react";
import { ViewTitle } from "./parts";

export type SourceKind = "mcp" | "api" | "graphql";

/** How a custom source authenticates. OAuth is a remote MCP server's browser sign-in. */
export type SourceAuth = "none" | "bearer" | "header" | "oauth";

/**
 * The preset a form was opened from: an MCP server preset, or a first-party API
 * source whose operations the server already knows.
 */
export type SourcePreset =
  | { kind: "mcp"; preset: McpSourcePreset }
  | { kind: "api"; preset: ApiConnectorPreset };

export type SourceForm = ReturnType<typeof useSourceForm>;

/** The fields of a custom MCP, OpenAPI, or GraphQL connector; each start fills them afresh. */
export function useSourceForm() {
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [sourcePreset, setSourcePreset] = useState<SourcePreset | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [authType, setAuthType] = useState<SourceAuth>("bearer");
  const [authName, setAuthName] = useState("x-api-key");
  const [sourceHint, setSourceHint] = useState<string | null>(null);

  function start(kind: SourceKind, preset: SourcePreset | null) {
    setSourceKind(kind);
    setSourcePreset(preset);
    setSourceHint(null);
    setSourceName(preset?.kind === "mcp" ? preset.preset.name : (preset?.preset.label ?? ""));
    setSourceUrl(
      preset?.kind === "mcp"
        ? (preset.preset.url ?? preset.preset.defaultUrl ?? "")
        : (preset?.preset.source ?? ""),
    );
    setCredential("");
    setAuthType(
      preset?.kind === "mcp" && preset.preset.signIn ? "oauth" : preset ? "bearer" : "none",
    );
    setAuthName("x-api-key");
  }

  /** A domain search result prefills the form with what it found. */
  function startFromCatalog(
    result: IntegrationCatalogResult,
    surface: IntegrationCatalogSurface,
    source: string,
  ) {
    setSourceKind(surface.kind === "mcp" ? "mcp" : "api");
    setSourcePreset(null);
    setSourceName(result.name);
    setSourceUrl(source);
    setCredential("");
    setAuthType(surface.auth?.type ?? "none");
    setAuthName(surface.auth?.headerName ?? "x-api-key");
    setSourceHint(surface.auth?.note ?? null);
  }

  function close() {
    setSourceKind(null);
    setSourceHint(null);
  }

  return {
    sourceKind,
    setSourceKind,
    sourcePreset,
    sourceName,
    setSourceName,
    sourceUrl,
    setSourceUrl,
    credential,
    setCredential,
    authType,
    setAuthType,
    authName,
    setAuthName,
    sourceHint,
    start,
    startFromCatalog,
    close,
  };
}

export function SourceFormView({
  form,
  installing,
  sourceError,
  onBack,
  onSubmit,
}: {
  form: SourceForm;
  installing: boolean;
  sourceError: string | null;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const { t } = useLingui();
  const {
    sourceKind,
    sourcePreset,
    sourceName,
    setSourceName,
    sourceUrl,
    setSourceUrl,
    credential,
    setCredential,
    authType,
    setAuthType,
    authName,
    setAuthName,
    sourceHint,
  } = form;
  if (!sourceKind) return null;
  const custom = !sourcePreset;
  const mcpPreset = sourcePreset?.kind === "mcp" ? sourcePreset.preset : null;
  const apiPreset = sourcePreset?.kind === "api" ? sourcePreset.preset : null;
  // OAuth saves the server before the browser sign-in, so it is not a check of typed credentials.
  const oauth = authType === "oauth";
  const submitLabel = installing ? (
    oauth ? (
      <Trans>Connecting…</Trans>
    ) : (
      <Trans>Verifying…</Trans>
    )
  ) : oauth ? (
    <Trans>Save and sign in</Trans>
  ) : (
    <Trans>Verify and add</Trans>
  );
  return (
    <div data-testid="integrations-source-form" className="max-w-xl space-y-6">
      <ViewTitle
        title={
          apiPreset ? (
            apiPreset.label
          ) : mcpPreset ? (
            mcpPreset.name
          ) : sourceKind === "mcp" ? (
            <Trans>MCP server</Trans>
          ) : sourceKind === "graphql" ? (
            "GraphQL"
          ) : (
            "OpenAPI"
          )
        }
        onBack={onBack}
      />
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {apiPreset ? null : (
          <Field>
            <FieldLabel htmlFor="source-name">
              <Trans>Name</Trans>
            </FieldLabel>
            <Input
              id="source-name"
              value={sourceName}
              onChange={(event) => setSourceName(event.target.value)}
              autoFocus
            />
          </Field>
        )}
        {!mcpPreset?.url && !apiPreset ? (
          <Field>
            <FieldLabel htmlFor="source-url">URL</FieldLabel>
            <Input
              id="source-url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder={
                mcpPreset?.urlPlaceholder ??
                (sourceKind === "mcp"
                  ? "https://example.com/mcp"
                  : sourceKind === "graphql"
                    ? "https://example.com/graphql"
                    : "https://example.com/openapi.json")
              }
            />
          </Field>
        ) : null}
        {custom ? (
          <Field>
            <FieldLabel htmlFor="source-auth">
              <Trans>Authentication</Trans>
            </FieldLabel>
            <OptionSelect<SourceAuth>
              id="source-auth"
              value={authType}
              options={[
                { value: "none", label: t`No authentication` },
                { value: "bearer", label: t`Bearer token` },
                { value: "header", label: t`API key header` },
                ...(sourceKind === "mcp" ? [{ value: "oauth" as const, label: t`OAuth` }] : []),
              ]}
              onValueChange={setAuthType}
            />
          </Field>
        ) : null}
        {custom && authType === "header" ? (
          <Field>
            <FieldLabel htmlFor="source-header">
              <Trans>Header name</Trans>
            </FieldLabel>
            <Input
              id="source-header"
              value={authName}
              onChange={(event) => setAuthName(event.target.value)}
            />
          </Field>
        ) : null}
        {(!custom || authType !== "none") && authType !== "oauth" ? (
          <Field>
            <FieldLabel htmlFor="source-credential">
              {apiPreset ? (
                <Trans>API key</Trans>
              ) : mcpPreset ? (
                <Trans>Bearer token</Trans>
              ) : (
                <Trans>Credential</Trans>
              )}
            </FieldLabel>
            <Input
              id="source-credential"
              type="password"
              autoComplete="new-password"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              autoFocus={apiPreset ? true : undefined}
            />
            <FieldDescription>
              <Trans>Credentials are encrypted and never sent to the model.</Trans>
            </FieldDescription>
          </Field>
        ) : null}
        {sourceHint ? <p className="text-body text-muted-foreground">{sourceHint}</p> : null}
        {sourceError ? (
          <p role="alert" className="text-body text-destructive">
            {sourceError}
          </p>
        ) : null}
        <Button type="submit" disabled={installing}>
          {submitLabel}
        </Button>
      </form>
    </div>
  );
}
