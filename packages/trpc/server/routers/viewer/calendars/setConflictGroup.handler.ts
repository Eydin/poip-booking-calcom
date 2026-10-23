import { SelectedCalendarRepository } from "@calcom/features/selectedCalendar/repositories/SelectedCalendarRepository";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import type { TSetConflictGroupInputSchema } from "./setConflictGroup.schema";

type SessionUser = NonNullable<TrpcSessionUser>;
type User = {
  id: SessionUser["id"];
};

type SetConflictGroupOptions = {
  ctx: {
    user: User;
  };
  input: TSetConflictGroupInputSchema;
};

/**
 * Sets (or clears) which AND-conflict-group a user-level calendar belongs to. Calendars sharing
 * a conflictGroupId are only considered "busy" when ALL of them are busy at the same time,
 * instead of the default OR semantics (busy if ANY selected calendar is busy). See
 * CalendarManager.ts's getBusyCalendarTimes for how this is applied.
 */
export const setConflictGroupHandler = async ({ ctx, input }: SetConflictGroupOptions) => {
  const { user } = ctx;
  const { integration, externalId, credentialId, conflictGroupId } = input;

  // Upsert rather than update: the group tag can be set right after flipping the
  // conflict-checking toggle on, before that toggle's own request has finished creating the
  // SelectedCalendar row. Upserting avoids a "SelectedCalendar not found" race in that case,
  // and converges to the same row either way once both requests have completed.
  await SelectedCalendarRepository.upsert({
    userId: user.id,
    integration,
    externalId,
    credentialId,
    eventTypeId: null,
    conflictGroupId,
  });
};
