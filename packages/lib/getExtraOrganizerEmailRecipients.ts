import type { CalendarEvent, Person } from "@calcom/types/Calendar";

/**
 * Extra addresses (comma-separated) that should receive the same organizer
 * notifications - and calendar invite - as the event type owner, without
 * being a real Cal.com user, team member, or attendee. Configured once via
 * env var rather than per-event-type, by design, to keep this simple.
 */
const EXTRA_ORGANIZER_EMAILS = (process.env.BOOKING_ORGANIZER_CC_EMAILS || "")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);

export function getExtraOrganizerEmailRecipients(calEvent: Pick<CalendarEvent, "organizer">): Person[] {
  return EXTRA_ORGANIZER_EMAILS.filter((email) => email !== calEvent.organizer.email).map((email) => ({
    ...calEvent.organizer,
    email,
  }));
}
