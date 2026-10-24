import type { EventTypeMetaDataSchema } from "@calcom/prisma/zod-utils";
import type { CalendarEvent, Person } from "@calcom/types/Calendar";
import type { z } from "zod";

type EventTypeMetadata = z.infer<typeof EventTypeMetaDataSchema>;

/**
 * Extra addresses that should receive the same organizer notifications -
 * and calendar invite - as the event type owner, without being a real
 * Cal.com user, team member, or attendee. Comes from two optional sources
 * that are merged together: a site-wide env var (BOOKING_ORGANIZER_CC_EMAILS,
 * comma-separated) and the event type's own "Notify additional emails"
 * setting (metadata.organizerCcEmails, set in the event type's Advanced tab).
 */
const SITE_WIDE_EXTRA_ORGANIZER_EMAILS = (process.env.BOOKING_ORGANIZER_CC_EMAILS || "")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);

export function getExtraOrganizerEmailRecipients(
  calEvent: Pick<CalendarEvent, "organizer">,
  eventTypeMetadata?: EventTypeMetadata
): Person[] {
  const emails = new Set([
    ...SITE_WIDE_EXTRA_ORGANIZER_EMAILS,
    ...(eventTypeMetadata?.organizerCcEmails ?? []),
  ]);
  emails.delete(calEvent.organizer.email);

  return Array.from(emails).map((email) => ({
    ...calEvent.organizer,
    email,
  }));
}
