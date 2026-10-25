#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.CALCOM_MCP_BASE_URL;
const SECRET = process.env.CALCOM_MCP_SECRET;

if (!BASE_URL || !SECRET) {
  console.error(
    "Missing env vars: CALCOM_MCP_BASE_URL and CALCOM_MCP_SECRET must both be set for the calcom-event-types MCP server."
  );
  process.exit(1);
}

async function callApi(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`Cal.com API error (${res.status}): ${JSON.stringify(json)}`);
  }

  return json;
}

function toToolResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function partial(shape) {
  const out = {};
  for (const [key, schema] of Object.entries(shape)) {
    out[key] = schema.optional();
  }
  return out;
}

const server = new McpServer({
  name: "calcom-event-types",
  version: "2.0.0",
});

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

const locationSchema = z.object({
  type: z.string().describe('e.g. "integrations:daily" (Cal Video), "inPerson", "link", "userPhone"'),
  address: z.string().optional().describe('Required for "inPerson" (Organizer Address)'),
  link: z.string().optional().describe('Required for "link" (generic link location)'),
  displayLocationPublicly: z.boolean().optional().describe("Show this location on the booking page before booking"),
  hostPhoneNumber: z.string().optional(),
  credentialId: z.number().optional(),
  teamName: z.string().optional(),
  customLabel: z.string().optional(),
});

// A single booking-page question. Pass the full current list on every write:
// the API replaces the whole bookingFields array, it doesn't merge by name.
// Common built-in `name`s already present on a new event type: "name",
// "email", "phone" (hidden by default), "notes", "guests", "rescheduleReason".
const bookingFieldSchema = z
  .object({
    name: z.string().describe('Stable identifier, e.g. "phone" for the built-in phone field'),
    type: z
      .string()
      .describe('"name" | "email" | "phone" | "address" | "text" | "textarea" | "number" | "boolean" | "radio" | "select" | "multiselect" | "multiemail" | "checkbox" | "radioInput"'),
    label: z.string().optional(),
    defaultLabel: z.string().optional(),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
    hidden: z.boolean().optional().describe("If true, the field is not shown on the booking page at all"),
    options: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
          price: z
            .number()
            .min(0)
            .optional()
            .describe(
              "For 'select' or 'checkbox' fields only (NOT 'radio' - its price-matching is broken in this Cal.com version, it silently charges $0 extra). Added to the event's base Stripe price, in major currency units (e.g. 500 for 500.00 CZK)."
            ),
        })
      )
      .optional(),
  })
  .passthrough();

// Cal.com's Stripe app-data shape stored at metadata.apps.stripe. Price is in
// the smallest currency unit (e.g. CZK/USD cents) - 4200 CZK = 420000.
const metadataSchema = z
  .object({
    apps: z
      .object({
        stripe: z
          .object({
            enabled: z.boolean().optional(),
            credentialId: z.number().optional().describe("Get this from an existing paid event type via get_event_type"),
            price: z.number().int().describe("Amount in the smallest currency unit, e.g. 420000 for 4,200.00 CZK"),
            currency: z.string().describe('Lowercase ISO code, e.g. "czk", "usd"'),
            paymentOption: z.enum(["ON_BOOKING", "HOLD"]).optional().describe("ON_BOOKING = collect payment on booking (default)"),
            refundPolicy: z.enum(["never", "always", "days"]).optional(),
            refundDaysCount: z.number().optional(),
            refundCountCalendarDays: z.boolean().optional(),
          })
          .partial()
          .optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    organizerCcEmails: z.array(z.string().email()).optional().describe("Extra addresses CC'd on organizer notifications"),
    additionalDayInvites: z
      .array(
        z.object({
          offsetDays: z.number().int().min(1).describe("Days after the booking's start date, e.g. 1 for 'the next day', 2 for 'two days later'"),
          startTime: z.string().describe('24h "HH:mm" in the event type\'s locked timezone (or the organizer\'s timezone), e.g. "09:30"'),
          endTime: z.string().describe('24h "HH:mm", e.g. "19:00"'),
          titleSuffix: z.string().optional().describe('Appended to the event title for this invite, e.g. "(Day 2)". Defaults to "(Day {offsetDays + 1})" when omitted'),
        })
      )
      .optional()
      .describe(
        "One entry per extra day of a multi-day program (day 2, day 3, day 4, ...): sends an additional, separate calendar invite for that day, on top of the normal invite for the booked slot. Does not change the booking's own bookable time."
      ),
  })
  .passthrough()
  .describe("Pass the full current metadata object on every write - it is replaced, not merged. Read it first with get_event_type.");

const createEventTypeFields = {
  title: z.string().min(1).describe("Display title of the event type"),
  slug: z
    .string()
    .describe("URL-safe slug, e.g. 'life-activation' -> booking page /<username>/life-activation"),
  description: z.string().nullish(),
  length: z.number().int().positive().describe("Duration in minutes"),
  hidden: z.boolean().optional().describe("If true, the event type is not publicly bookable"),
  locations: z.array(locationSchema).optional(),
  scheduleId: z.number().int().optional().describe("ID of an existing availability schedule to attach (see list_schedules/create_schedule)"),
  minimumBookingNotice: z.number().int().min(0).optional().describe("Minutes of notice required before booking"),
  beforeEventBuffer: z.number().int().min(0).optional(),
  afterEventBuffer: z.number().int().min(0).optional(),
  slotInterval: z.number().min(0).nullish().describe("Override slot interval in minutes"),
  metadata: metadataSchema.optional(),
};

// Superset of fields usable on update. Only pass what you want to change.
const updateOnlyEventTypeFields = {
  timeZone: z.string().nullish().describe("Required when lockTimeZoneToggleOnBookingPage is true, e.g. 'Europe/Prague'"),
  lockTimeZoneToggleOnBookingPage: z.boolean().optional().describe("Lock the booking page to a single timezone - useful for in-person events"),
  lockedTimeZone: z.string().nullish(),
  requiresConfirmation: z.boolean().optional(),
  requiresBookerEmailVerification: z.boolean().optional(),
  disableGuests: z.boolean().optional().describe("Hide the 'Add guests' booking field"),
  hideCalendarNotes: z.boolean().optional(),
  hideCalendarEventDetails: z.boolean().optional(),
  hideOrganizerEmail: z.boolean().optional(),
  bookingFields: z.array(bookingFieldSchema).optional().describe("Replaces the full booking-questions list - read current value with get_event_type first"),
  seatsPerTimeSlot: z.number().int().min(1).max(1000).nullable().optional().describe("Enables 'Offer seats' (multiple independent bookers per slot). Max 1000; use e.g. 999 for 'effectively unlimited'"),
  seatsShowAttendees: z.boolean().nullable().optional().describe("Share attendee info between guests booking the same seat slot"),
  seatsShowAvailabilityCount: z.boolean().nullable().optional().describe("Show remaining seat count to bookers"),
  disableCancelling: z.boolean().nullable().optional(),
  disableRescheduling: z.boolean().nullable().optional().describe("Fully disable rescheduling. For a notice-period cutoff instead, use minimumRescheduleNotice"),
  minimumRescheduleNotice: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe("Minutes before the booking start after which rescheduling is blocked, e.g. 7200 for 'no reschedules within 5 days'. Leave disableRescheduling false/unset when using this."),
  allowReschedulingPastBookings: z.boolean().optional(),
  allowReschedulingCancelledBookings: z.boolean().nullable().optional(),
  requiresCancellationReason: z
    .enum(["MANDATORY_BOTH", "MANDATORY_HOST_ONLY", "MANDATORY_ATTENDEE_ONLY", "OPTIONAL_BOTH"])
    .nullable()
    .optional(),
  successRedirectUrl: z.string().nullable().optional(),
  forwardParamsSuccessRedirect: z.boolean().nullable().optional(),
  customReplyToEmail: z.string().nullable().optional(),
  useEventLevelSelectedCalendars: z
    .boolean()
    .optional()
    .describe(
      "true = this event type's own 'Check for conflicts' calendar scope (shows as 'Event Type' in the UI) instead of the account-wide scope. With no per-event-type calendars ever toggled on, conflict checking is effectively off for just this event type."
    ),
};

server.tool(
  "list_event_types",
  "List all personal (non-team) Cal.com event types on this booking deployment.",
  {},
  async () => {
    const data = await callApi("/api/mcp/event-types", { method: "GET" });
    return toToolResult(data.eventTypes ?? data);
  }
);

server.tool(
  "get_event_type",
  "Get full details of a single Cal.com event type by id - including its current bookingFields and metadata (read these before writing them back, since both are replaced wholesale on update).",
  { id: z.number().int().describe("Event type id, from list_event_types") },
  async ({ id }) => {
    const data = await callApi(`/api/mcp/event-types/${id}`, { method: "GET" });
    return toToolResult(data);
  }
);

server.tool(
  "create_event_type",
  "Create a new Cal.com event type (a bookable class/session type). Follow up with update_event_type for seats, booking questions, Stripe payment, timezone lock, etc. - those can't all be set on create.",
  createEventTypeFields,
  async (input) => {
    const data = await callApi("/api/mcp/event-types", { method: "POST", body: input });
    return toToolResult(data.eventType ?? data);
  }
);

server.tool(
  "update_event_type",
  "Update fields on an existing Cal.com event type. Only pass the fields you want to change. bookingFields and metadata are replaced wholesale, not merged - fetch the current value with get_event_type first if you're adding to an existing list rather than setting it from scratch.",
  {
    id: z.number().int().describe("Event type id to update"),
    ...partial(createEventTypeFields),
    ...updateOnlyEventTypeFields,
  },
  async ({ id, ...rest }) => {
    const data = await callApi(`/api/mcp/event-types/${id}`, { method: "PATCH", body: rest });
    return toToolResult(data);
  }
);

server.tool(
  "delete_event_type",
  "Permanently delete a Cal.com event type by id.",
  { id: z.number().int().describe("Event type id to delete") },
  async ({ id }) => {
    const data = await callApi(`/api/mcp/event-types/${id}`, { method: "DELETE" });
    return toToolResult(data);
  }
);

// ---------------------------------------------------------------------------
// Availability schedules
// ---------------------------------------------------------------------------

const dateRangeSchema = z.object({
  start: z.string().describe("ISO datetime, e.g. '2026-10-31T10:00:00'"),
  end: z.string().describe("ISO datetime, e.g. '2026-10-31T14:30:00'"),
});

server.tool(
  "list_schedules",
  "List all availability schedules owned by this account.",
  {},
  async () => {
    const data = await callApi("/api/mcp/schedules", { method: "GET" });
    return toToolResult(data.schedules ?? data);
  }
);

server.tool(
  "get_schedule",
  "Get full details (weekly availability + date overrides) of a single availability schedule by id.",
  { id: z.number().int().describe("Schedule id, from list_schedules") },
  async ({ id }) => {
    const data = await callApi(`/api/mcp/schedules/${id}`, { method: "GET" });
    return toToolResult(data);
  }
);

server.tool(
  "create_schedule",
  "Create a new availability schedule. Create it bare (just a name) then use update_schedule to set the weekly hours and/or date overrides - this mirrors the two-step flow the Cal.com UI itself uses.",
  {
    name: z.string().min(1).describe('e.g. "Sacred Geometry 1 Class Dates"'),
    schedule: z
      .array(z.array(dateRangeSchema))
      .length(7)
      .optional()
      .describe("Optional initial weekly hours: exactly 7 arrays (Sun..Sat), each a list of available time ranges that weekday. Omit, or use all-empty arrays, for a schedule driven entirely by dateOverrides."),
    eventTypeId: z.number().int().optional().describe("Optionally attach this schedule to an event type immediately"),
  },
  async (input) => {
    const data = await callApi("/api/mcp/schedules", { method: "POST", body: input });
    return toToolResult(data.schedule ?? data);
  }
);

server.tool(
  "update_schedule",
  "Update an availability schedule's weekly hours, one-off date overrides, timezone, or name. Both `schedule` and `dateOverrides`, when passed, REPLACE the full existing set for that part - they are not merged with what's already saved, so include every day/override you want to keep.",
  {
    id: z.number().int().describe("Schedule id to update"),
    name: z.string().min(1).optional(),
    timeZone: z.string().optional().describe("IANA name, e.g. 'Europe/Prague'"),
    isDefault: z.boolean().optional(),
    schedule: z
      .array(z.array(dateRangeSchema))
      .length(7)
      .optional()
      .describe("Full replacement weekly hours: exactly 7 arrays (Sun..Sat). Pass 7 empty arrays to disable all recurring weekly availability."),
    dateOverrides: z
      .array(dateRangeSchema)
      .optional()
      .describe("Full replacement list of one-off bookable date/time ranges, independent of the weekly schedule. Pass every date you want bookable, not just new ones."),
  },
  async ({ id, ...rest }) => {
    const data = await callApi(`/api/mcp/schedules/${id}`, { method: "PATCH", body: rest });
    return toToolResult(data);
  }
);

server.tool(
  "delete_schedule",
  "Permanently delete an availability schedule by id. Fails if it's the account's only remaining schedule.",
  { id: z.number().int().describe("Schedule id to delete") },
  async ({ id }) => {
    const data = await callApi(`/api/mcp/schedules/${id}`, { method: "DELETE" });
    return toToolResult(data);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
