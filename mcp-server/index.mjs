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

const server = new McpServer({
  name: "calcom-event-types",
  version: "1.0.0",
});

const locationSchema = z.object({
  type: z.string().describe('e.g. "integrations:daily" (Cal Video), "inPerson", "link", "userPhone"'),
  address: z.string().optional(),
  link: z.string().optional(),
  displayLocationPublicly: z.boolean().optional(),
  hostPhoneNumber: z.string().optional(),
  credentialId: z.number().optional(),
  teamName: z.string().optional(),
  customLabel: z.string().optional(),
});

const eventTypeFields = {
  title: z.string().min(1).describe("Display title of the event type"),
  slug: z
    .string()
    .describe("URL-safe slug, e.g. 'life-activation' -> booking page /<username>/life-activation"),
  description: z.string().nullish(),
  length: z.number().int().positive().describe("Duration in minutes"),
  hidden: z.boolean().optional().describe("If true, the event type is not publicly bookable"),
  locations: z.array(locationSchema).optional(),
  scheduleId: z.number().int().optional().describe("ID of an existing availability schedule to attach"),
  minimumBookingNotice: z.number().int().min(0).optional().describe("Minutes of notice required before booking"),
  beforeEventBuffer: z.number().int().min(0).optional(),
  afterEventBuffer: z.number().int().min(0).optional(),
  slotInterval: z.number().min(0).nullish().describe("Override slot interval in minutes"),
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
  "Get full details of a single Cal.com event type by id.",
  { id: z.number().int().describe("Event type id, from list_event_types") },
  async ({ id }) => {
    const data = await callApi(`/api/mcp/event-types/${id}`, { method: "GET" });
    return toToolResult(data);
  }
);

server.tool(
  "create_event_type",
  "Create a new Cal.com event type (a bookable class/session type).",
  eventTypeFields,
  async (input) => {
    const data = await callApi("/api/mcp/event-types", { method: "POST", body: input });
    return toToolResult(data.eventType ?? data);
  }
);

server.tool(
  "update_event_type",
  "Update fields on an existing Cal.com event type. Only pass the fields you want to change.",
  { id: z.number().int().describe("Event type id to update"), ...partial(eventTypeFields) },
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

function partial(shape) {
  const out = {};
  for (const [key, schema] of Object.entries(shape)) {
    out[key] = schema.optional();
  }
  return out;
}

const transport = new StdioServerTransport();
await server.connect(transport);
