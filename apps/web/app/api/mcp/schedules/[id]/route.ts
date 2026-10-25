import type { Params } from "app/_types";
import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@calcom/prisma";

import { getMcpActingUser } from "../../event-types/_shared";

const paramsSchema = z.object({ id: z.coerce.number().int() });

const dateRangeSchema = z.object({ start: z.coerce.date(), end: z.coerce.date() });

const patchBodySchema = z.object({
  timeZone: z.string().optional(),
  name: z.string().trim().min(1, "Schedule name cannot be empty").optional(),
  isDefault: z.boolean().optional(),
  // One array per weekday (0=Sunday..6=Saturday); each entry is an available
  // time-of-day range. An empty array for a weekday means unavailable that
  // weekday. Pass seven empty arrays to disable all recurring availability
  // and rely only on dateOverrides below.
  schedule: z.array(z.array(dateRangeSchema)).optional(),
  // One-off availability for specific calendar dates, independent of the
  // weekly `schedule`. Each entry's start/end date (not just time) is used.
  dateOverrides: z.array(dateRangeSchema).optional(),
});

async function getHandler(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = paramsSchema.parse(await params);
  const user = await getMcpActingUser(req);

  const { getHandler: getScheduleHandler } = await import(
    "@calcom/trpc/server/routers/viewer/availability/schedule/get.handler"
  );
  const result = await getScheduleHandler({ ctx: { user }, input: { scheduleId: id } });

  return NextResponse.json(result);
}

async function patchHandler(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = paramsSchema.parse(await params);
  const user = await getMcpActingUser(req);
  const body = patchBodySchema.parse(await req.json());

  // The underlying ScheduleService.update silently skips writing `schedule`/
  // `dateOverrides` whenever `name` is omitted (it's used as a signal this
  // is a "just set as default" call). Always resolve a name so availability
  // changes from this endpoint actually take effect.
  let name = body.name;
  if (!name) {
    const existing = await prisma.schedule.findUnique({ where: { id }, select: { name: true } });
    if (!existing) {
      return NextResponse.json({ message: "Schedule not found" }, { status: 404 });
    }
    name = existing.name;
  }

  const { updateHandler } = await import(
    "@calcom/trpc/server/routers/viewer/availability/schedule/update.handler"
  );
  const result = await updateHandler({ ctx: { user }, input: { ...body, name, scheduleId: id } });

  return NextResponse.json(result);
}

async function deleteHandler(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = paramsSchema.parse(await params);
  const user = await getMcpActingUser(req);

  const { deleteHandler: deleteScheduleHandler } = await import(
    "@calcom/trpc/server/routers/viewer/availability/schedule/delete.handler"
  );
  await deleteScheduleHandler({ ctx: { user }, input: { scheduleId: id } });

  return NextResponse.json({ success: true });
}

export const GET = defaultResponderForAppDir(getHandler);
export const PATCH = defaultResponderForAppDir(patchHandler);
export const DELETE = defaultResponderForAppDir(deleteHandler);
