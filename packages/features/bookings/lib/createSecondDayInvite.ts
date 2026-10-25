import dayjs from "@calcom/dayjs";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import type { EventTypeMetadata } from "@calcom/prisma/zod-utils";
import type { CalendarEvent } from "@calcom/types/Calendar";

import type EventManager from "./EventManager";

const log = logger.getSubLogger({ prefix: ["[createSecondDayInvite]"] });

/**
 * For an event type whose metadata has `secondDayInvite.enabled`, creates an
 * additional calendar event/invite for a later day of the same program (e.g.
 * a 2-day Initiation whose single bookable slot only covers day 1). This
 * never touches the booking's own start/end time or its primary calendar
 * event - it's a second, independent invite sent via the same calendar
 * credentials, so organizer and attendee both see both days blocked.
 *
 * Any failure here is swallowed (logged only) so it can never block the
 * booking's own confirmation/calendar-event/email flow.
 */
export async function createSecondDayInvite({
  evt,
  eventTypeMetadata,
  eventManager,
}: {
  evt: CalendarEvent;
  eventTypeMetadata: EventTypeMetadata | null | undefined;
  eventManager: EventManager;
}) {
  const config = eventTypeMetadata?.secondDayInvite;
  if (!config?.enabled || !config.offsetDays || !config.startTime || !config.endTime) {
    return [];
  }

  try {
    const timeZone = evt.organizer.timeZone;
    const [startHour, startMinute] = config.startTime.split(":").map(Number);
    const [endHour, endMinute] = config.endTime.split(":").map(Number);

    if ([startHour, startMinute, endHour, endMinute].some((n) => Number.isNaN(n))) {
      log.error("Invalid secondDayInvite startTime/endTime", safeStringify(config));
      return [];
    }

    const baseDay = dayjs(evt.startTime).tz(timeZone).add(config.offsetDays, "day");
    const day2Start = baseDay.hour(startHour).minute(startMinute).second(0).millisecond(0);
    const day2End = baseDay.hour(endHour).minute(endMinute).second(0).millisecond(0);

    const day2Evt: CalendarEvent = {
      ...evt,
      startTime: day2Start.toISOString(),
      endTime: day2End.toISOString(),
      uid: evt.uid ? `${evt.uid}-day${config.offsetDays + 1}` : evt.uid,
      title: config.titleSuffix ? `${evt.title} ${config.titleSuffix}` : evt.title,
      iCalUID: undefined,
    };

    const result = await eventManager.create(day2Evt);
    return result.referencesToCreate;
  } catch (error) {
    log.error("Failed to create second-day calendar invite", safeStringify(error));
    return [];
  }
}
