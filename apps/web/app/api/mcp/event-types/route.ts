import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { createEventTypeInput } from "@calcom/features/eventtypes/lib/schemas";
import prisma from "@calcom/prisma";

import { getMcpActingUser } from "./_shared";

async function getHandler(req: NextRequest) {
  const user = await getMcpActingUser(req);
  const { listHandler } = await import("@calcom/trpc/server/routers/viewer/eventTypes/list.handler");

  const eventTypes = await listHandler({ ctx: { user } });
  return NextResponse.json({ eventTypes });
}

async function postHandler(req: NextRequest) {
  const user = await getMcpActingUser(req);
  const input = createEventTypeInput.parse(await req.json());

  const { createHandler } = await import(
    "@calcom/trpc/server/routers/viewer/eventTypes/heavy/create.handler"
  );
  const { eventType } = await createHandler({ ctx: { user, prisma }, input });

  return NextResponse.json({ eventType });
}

export const GET = defaultResponderForAppDir(getHandler);
export const POST = defaultResponderForAppDir(postHandler);
