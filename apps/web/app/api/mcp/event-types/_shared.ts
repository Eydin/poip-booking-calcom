import type { NextRequest } from "next/server";
import type { Session } from "next-auth";

import { getUserSession } from "@calcom/features/auth/lib/userFromSessionUtils";
import { HttpError } from "@calcom/lib/http-error";
import prisma from "@calcom/prisma";

/**
 * Authenticates a request from the local calcom-event-types MCP server (a bearer
 * secret, not a real session) and builds the exact same ctx.user shape the real
 * tRPC session middleware builds (isAuthed also calls getUserSession), by passing
 * a synthetic session for the single fixed Cal.com account this endpoint acts as.
 */
export async function getMcpActingUser(req: NextRequest) {
  const expectedSecret = process.env.MCP_EVENT_TYPES_SECRET;
  if (!expectedSecret) {
    throw new HttpError({ statusCode: 500, message: "MCP_EVENT_TYPES_SECRET is not configured" });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader !== `Bearer ${expectedSecret}`) {
    throw new HttpError({ statusCode: 401, message: "Invalid or missing bearer token" });
  }

  const targetEmail = process.env.MCP_EVENT_TYPES_USER_EMAIL;
  if (!targetEmail) {
    throw new HttpError({ statusCode: 500, message: "MCP_EVENT_TYPES_USER_EMAIL is not configured" });
  }

  const targetUser = await prisma.user.findUnique({
    where: { email: targetEmail },
    select: { id: true },
  });
  if (!targetUser) {
    throw new HttpError({ statusCode: 500, message: `No Cal.com user found for ${targetEmail}` });
  }

  const fakeSession = { user: { id: targetUser.id } } as unknown as Session;
  const { user } = await getUserSession({ locale: "en", session: fakeSession });
  if (!user) {
    throw new HttpError({ statusCode: 500, message: "Failed to build user context for MCP request" });
  }

  return user;
}

/**
 * This endpoint only ever acts on personal (non-team) event types owned by the
 * single fixed account above. Reject anything else, mirroring the ownership
 * check createEventPbacProcedure performs for real session-based requests.
 */
export async function assertOwnsPersonalEventType(userId: number, eventTypeId: number) {
  const eventType = await prisma.eventType.findUnique({
    where: { id: eventTypeId },
    select: { id: true, userId: true, teamId: true },
  });

  if (!eventType) {
    throw new HttpError({ statusCode: 404, message: "Event type not found" });
  }
  if (eventType.teamId !== null || eventType.userId !== userId) {
    throw new HttpError({ statusCode: 403, message: "Not permitted to access this event type" });
  }
}
