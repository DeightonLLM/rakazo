import * as z from "zod";

/**
 * A first-party API source an operator can add without typing its operations.
 *
 * The preset describes where the source lives and what it can read. The
 * credential is never part of it: it goes to the install's encrypted credential
 * field, and the client sends it once, to the server, and never sees it back.
 */
export const ApiConnectorPresetSchema = z.object({
  /** Stable id the install records. */
  id: z.string().min(1).max(120),
  /** Name a person reads in the integrations list. */
  label: z.string().min(1).max(120),
  /** Where the source lives. */
  source: z.string().min(1).max(2048),
  /** The reads the source offers, by name. */
  operations: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        description: z.string().max(2_000),
      }),
    )
    .max(100),
});
export type ApiConnectorPreset = z.infer<typeof ApiConnectorPresetSchema>;
