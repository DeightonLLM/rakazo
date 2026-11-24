import { Trans, useLingui } from "@lingui/react/macro";
import type { ApiConnectorPreset, McpSourcePreset } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { Plus } from "lucide-react";
import type { SourceKind, SourcePreset } from "./source-form";

/** The + menu: a plugin from GitHub, a custom connector, or the MCP and domain catalogs. */
export function AddMenu({
  presets,
  apiPresets,
  onGithub,
  onSource,
  onBrowseMcp,
  onDomainSearch,
  onOpenMcp,
}: {
  presets: McpSourcePreset[];
  /** The first-party API sources the server offers, ready to add. */
  apiPresets: ApiConnectorPreset[];
  onGithub: () => void;
  onSource: (kind: SourceKind, preset?: SourcePreset) => void;
  onBrowseMcp: () => void;
  /** Only where the deployment offers the domain catalog. */
  onDomainSearch?: () => void;
  onOpenMcp?: () => void;
}) {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={t`Add custom`} />}
      >
        <Plus />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onGithub}>
          <Trans>From GitHub</Trans>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onSource("mcp")}>
          <Trans>MCP server</Trans>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSource("api")}>OpenAPI</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSource("graphql")}>GraphQL</DropdownMenuItem>
        {presets.map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            onClick={() => onSource("mcp", { kind: "mcp", preset })}
          >
            {preset.name}
          </DropdownMenuItem>
        ))}
        {apiPresets.map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            onClick={() => onSource("api", { kind: "api", preset })}
          >
            {preset.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onBrowseMcp}>
          <Trans>Browse MCP servers</Trans>
        </DropdownMenuItem>
        {onDomainSearch ? (
          <DropdownMenuItem onClick={onDomainSearch}>
            <Trans>Search by domain</Trans>
          </DropdownMenuItem>
        ) : null}
        {onOpenMcp ? (
          <DropdownMenuItem onClick={onOpenMcp}>
            <Trans>Manage MCP servers</Trans>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
