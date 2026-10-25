import dayjs from "@calcom/dayjs";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import type { EventTypeMetadata } from "@calcom/prisma/zod-utils";
import type { CalendarEvent } from "@calcom/types/Calendar";

import type EventManager from "./EventManager";

const log = logger.getSubLogger({ prefix: ["[createAdditionalDayInvites]"] });

/**
 * For an event type whose metadata has `additionalDayInvites` entries,
 * creates one additional calendar event/invite per entry for a later day of
 * the same program (e.g. a multi-day workshop whose single bookable slot
 * only covers day 1). This never touches the booking's own start/end time
 * or its primary calendar event - each is a separate, independent invite
 * sent via the same calendar credentials, so organizer and attendee both
 * see every day blocked.
 *
 * A failure on one entry is logged and that entry is skipped - it never
 * blocks the booking's own confirmation/calendar-event/email flow, or the
 * other entries.
 */
export async function createAdditionalDayInvites({
  evt,
  eventTypeMetadata,
  eventManager,
}: {
  evt: CalendarEvent;
  eventTypeMetadata: EventTypeMetadata | null | undefined;
  eventManager: EventManager;
}) {
  const entries = eventTypeMetadata?.additionalDayInvites;
  if (!entries?.length) {
    return [];
  }

  const allReferences = [];

  for (const entry of entries) {
    try {
      const timeZone = evt.organizer.timeZone;
      const [startHour, startMinute] = entry.startTime.split(":").map(Number);
      const [endHour, endMinute] = entry.endTime.split(":").map(Number);

      if ([startHour, startMinute, endHour, endMinute].some((n) => Number.isNaN(n))) {
        log.error("Invalid additionalDayInvites startTime/endTime", safeStringify(entry));
        continue;
      }

      const baseDay = dayjs(evt.startTime).tz(timeZone).add(entry.offsetDays, "day");
      const dayStart = baseDay.hour(startHour).minute(startMinute).second(0).millisecond(0);
      const dayEnd = baseDay.hour(endHour).minute(endMinute).second(0).millisecond(0);

      const dayNumber = entry.offsetDays + 1;
      const titleSuffix = entry.titleSuffix || `(Day ${dayNumber})`;

      const dayEvt: CalendarEvent = {
        ...evt,
        startTime: dayStart.toISOString(),
        endTime: dayEnd.toISOString(),
        uid: evt.uid ? `${evt.uid}-day${dayNumber}` : evt.uid,
        title: `${evt.title} ${titleSuffix}`,
        iCalUID: undefined,
      };

      const result = await eventManager.create(dayEvt);
      allReferences.push(...result.referencesToCreate);
    } catch (error) {
      log.error("Failed to create an additional-day calendar invite", safeStringify({ entry, error }));
    }
  }

  return allReferences;
}
