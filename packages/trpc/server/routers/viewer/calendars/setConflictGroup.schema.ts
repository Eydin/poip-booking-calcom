import { z } from "zod";

export type TSetConflictGroupInputSchema = {
  integration: string;
  externalId: string;
  credentialId: number;
  /** Null/empty clears grouping (back to default OR semantics). */
  conflictGroupId: string | null;
};

export const ZSetConflictGroupInputSchema: z.ZodType<TSetConflictGroupInputSchema> = z.object({
  integration: z.string(),
  externalId: z.string(),
  credentialId: z.number(),
  conflictGroupId: z.string().trim().min(1).nullable(),
});
