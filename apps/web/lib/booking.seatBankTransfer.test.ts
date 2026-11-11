import prismock from "@calcom/testing/lib/__mocks__/prisma";
import { beforeEach, describe, expect, it } from "vitest";

// Importing @calcom/prisma is what starts the in-memory prismock database used below.
import "@calcom/prisma";

import { handleSeatsEventTypeOnBooking } from "./booking";

const seatedEventType = { seatsPerTimeSlot: 10, seatsShowAttendees: false, seatsShowAvailabilityCount: false };

describe("confirmation page of a seated booking (group class): bank-transfer QR", () => {
  let bookingMetadata: Record<string, string>;
  let bankPayerAttendeeId: number;

  beforeEach(async () => {
    // What an older version left on the shared booking: another attendee's QR.
    bookingMetadata = {
      videoCallUrl: "https://example.com/call",
      bankTransferSpayd: "SPD*someone-else",
      bankTransferVariableSymbol: "1",
    };
    const booking = await prismock.booking.create({
      data: {
        uid: "class-booking",
        title: "Sacred Geometry 1 Class",
        startTime: new Date("2026-12-01T10:00:00Z"),
        endTime: new Date("2026-12-01T14:30:00Z"),
        metadata: bookingMetadata,
      },
    });
    const attendee = (email: string) =>
      prismock.attendee.create({
        data: { email, name: email, timeZone: "Europe/Prague", locale: "en", bookingId: booking.id },
      });
    const cardPayer = await attendee("card@example.com");
    const bankPayer = await attendee("bank@example.com");
    bankPayerAttendeeId = bankPayer.id;

    const seatData = (email: string) => ({ responses: { name: email, email } });
    await prismock.bookingSeat.create({
      data: { referenceUid: "seat-card", bookingId: booking.id, attendeeId: cardPayer.id, data: seatData("card@example.com") },
    });
    await prismock.bookingSeat.create({
      data: {
        referenceUid: "seat-bank",
        bookingId: booking.id,
        attendeeId: bankPayer.id,
        data: seatData("bank@example.com"),
        metadata: {
          bankTransferSpayd: "SPD*mine",
          bankTransferVariableSymbol: String(bankPayer.id),
          bankTransferAmount: "4200.00",
        },
      },
    });
  });

  const bookingInfo = () => ({
    metadata: bookingMetadata,
    attendees: [
      { name: "card", email: "card@example.com", phoneNumber: null },
      { name: "bank", email: "bank@example.com", phoneNumber: null },
    ],
  });

  it("shows the attendee who chose bank transfer their own QR and reference number", async () => {
    const result = await handleSeatsEventTypeOnBooking(seatedEventType, bookingInfo(), "seat-bank");

    expect(result.metadata).toEqual({
      videoCallUrl: "https://example.com/call",
      bankTransferSpayd: "SPD*mine",
      bankTransferVariableSymbol: String(bankPayerAttendeeId),
      bankTransferAmount: "4200.00",
    });
  });

  it("shows an attendee who paid by card no QR at all", async () => {
    const result = await handleSeatsEventTypeOnBooking(seatedEventType, bookingInfo(), "seat-card");

    expect(result.metadata).toEqual({ videoCallUrl: "https://example.com/call" });
  });

  it("shows the host (no seat) no attendee's QR", async () => {
    const result = await handleSeatsEventTypeOnBooking(seatedEventType, bookingInfo(), undefined, true);

    expect(result.metadata).toEqual({ videoCallUrl: "https://example.com/call" });
  });
});
