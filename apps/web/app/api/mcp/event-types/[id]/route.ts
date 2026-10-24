import type { Params } from "app/_types";
import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@calcom/prisma";

import { assertOwnsPersonalEventType, getMcpActingUser } from "../_shared";

const paramsSchema = z.object({ id: z.coerce.number().int() });

async function getHandler(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = paramsSchema.parse(await params);
  const user = await getMcpActingUser(req);
  await assertOwnsPersonalEventType(user.id, id);

  const { getHandler: getEventTypeHandler } = await import(
    "@calcom/trpc/server/routers/viewer/eventTypes/get.handler"
  );
  const result = await getEventTypeHandler({ ctx: { user, prisma }, input: { id } });

  return NextResponse.json(result);
}

async function patchHandler(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = paramsSchema.parse(await params);
  const user = await getMcpActingUser(req);
  await assertOwnsPersonalEventType(user.id, id);

  const { ZUpdateInputSchema } = await import("@calcom/trpc/server/routers/viewer/eventTypes/types");
  const body = (await req.json()) as Record<string, unknown>;
  const input = ZUpdateInputSchema.parse({ ...body, id });

  const { updateHandler } = await import(
    "@calcom/trpc/server/routers/viewer/eventTypes/heavy/update.handler"
  );
  const result = await updateHandler({ ctx: { user, prisma }, input });

  return NextResponse.json(result);
}

async function deleteHandler(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = paramsSchema.parse(await params);
  const user = await getMcpActingUser(req);
  await assertOwnsPersonalEventType(user.id, id);

  const { deleteHandler: deleteEventTypeHandler } = await import(
    "@calcom/trpc/server/routers/viewer/eventTypes/delete.handler"
  );
  const result = await deleteEventTypeHandler({ ctx: { user }, input: { id } });

  return NextResponse.json(result);
}

export const GET = defaultResponderForAppDir(getHandler);
export const PATCH = defaultResponderForAppDir(patchHandler);
export const DELETE = defaultResponderForAppDir(deleteHandler);
