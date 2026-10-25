import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getMcpActingUser } from "../event-types/_shared";

const dateRangeSchema = z.object({ start: z.coerce.date(), end: z.coerce.date() });

const createBodySchema = z.object({
  name: z.string().trim().min(1, "Schedule name cannot be empty"),
  schedule: z.array(z.array(dateRangeSchema)).optional(),
  eventTypeId: z.number().int().optional(),
});

async function getHandler(req: NextRequest) {
  const user = await getMcpActingUser(req);
  const { getAllSchedulesByUserIdHandler } = await import(
    "@calcom/trpc/server/routers/viewer/availability/schedule/getAllSchedulesByUserId.handler"
  );

  const data = await getAllSchedulesByUserIdHandler({ ctx: { user }, input: { userId: user.id } });
  return NextResponse.json(data);
}

async function postHandler(req: NextRequest) {
  const user = await getMcpActingUser(req);
  const input = createBodySchema.parse(await req.json());

  const { createHandler } = await import(
    "@calcom/trpc/server/routers/viewer/availability/schedule/create.handler"
  );
  const data = await createHandler({ ctx: { user }, input });

  return NextResponse.json(data);
}

export const GET = defaultResponderForAppDir(getHandler);
export const POST = defaultResponderForAppDir(postHandler);
