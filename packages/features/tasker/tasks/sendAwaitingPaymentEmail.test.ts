import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPaymentLink } from "@calcom/app-store/stripepayment/lib/client";
import { sendAwaitingPaymentEmailAndSMS } from "@calcom/emails/email-manager";
import { getBooking } from "@calcom/features/bookings/lib/payment/getBooking";
import { BookingStatus } from "@calcom/prisma/enums";

import { sendAwaitingPaymentEmail } from "./sendAwaitingPaymentEmail";

const { findPayment, findSeatAttendees } = vi.hoisted(() => ({
  findPayment: vi.fn(),
  findSeatAttendees: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: {}, prisma: {} }));
vi.mock("@calcom/app-store/stripepayment/lib/client", () => ({
  createPaymentLink: vi.fn(({ paymentUid }: { paymentUid: string }) => `https://booking.example.com/payment/${paymentUid}`),
}));
vi.mock("@calcom/emails/email-manager", () => ({ sendAwaitingPaymentEmailAndSMS: vi.fn() }));
vi.mock("@calcom/features/bookings/lib/payment/getBooking", () => ({ getBooking: vi.fn() }));
vi.mock("@calcom/features/bookings/repositories/PrismaBookingPaymentRepository", () => ({
  PrismaBookingPaymentRepository: class {
    findByIdForAwaitingPaymentEmail = findPayment;
  },
}));
vi.mock("@calcom/features/bookings/repositories/AttendeeRepository", () => ({
  AttendeeRepository: class {
    findByBookingIdAndSeatReference = findSeatAttendees;
  },
}));

const mockedGetBooking = vi.mocked(getBooking);
const mockedSend = vi.mocked(sendAwaitingPaymentEmailAndSMS);

const attendees = [
  { name: "Seat One", email: "one@example.com" },
  { name: "Seat Two", email: "Two@Example.com" },
];

function arrange({
  bookingStatus = BookingStatus.PENDING,
  paid = false,
  payment = {
    uid: "payment-uid-1",
    success: false,
    paymentOption: "ON_BOOKING",
    amount: 420000,
    currency: "czk",
  } as Record<string, unknown> | null,
} = {}) {
  mockedGetBooking.mockResolvedValue({
    booking: { status: bookingStatus, paid, startTime: new Date("2026-12-01T10:00:00Z") },
    evt: { title: "Sacred Geometry 1 Class", attendees },
    eventType: { metadata: { some: "metadata" } },
  } as never);
  findPayment.mockResolvedValue(payment);
}

const run = (payload: Record<string, unknown> = { bookingId: 10, paymentId: 99 }) =>
  sendAwaitingPaymentEmail(JSON.stringify(payload));

describe("sendAwaitingPaymentEmail task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emails every attendee a link back to the payment page with the amount due", async () => {
    arrange();

    await run();

    expect(findPayment).toHaveBeenCalledWith(99);
    expect(createPaymentLink).toHaveBeenCalledWith({
      paymentUid: "payment-uid-1",
      name: "Seat One",
      email: "one@example.com",
      date: "2026-12-01T10:00:00.000Z",
    });
    expect(mockedSend).toHaveBeenCalledWith(
      expect.objectContaining({
        attendees,
        paymentInfo: {
          link: "https://booking.example.com/payment/payment-uid-1",
          paymentOption: "ON_BOOKING",
          amount: 420000,
          currency: "czk",
        },
      }),
      { some: "metadata" }
    );
  });

  it.each([
    ["the payment no longer exists", { payment: null }],
    ["the payment already succeeded", { payment: { uid: "p", success: true, amount: 1, currency: "czk" } }],
    ["the booking is already paid", { paid: true }],
    ["the booking was cancelled", { bookingStatus: BookingStatus.CANCELLED }],
    ["the booking was rejected", { bookingStatus: BookingStatus.REJECTED }],
  ])("sends nothing when %s", async (_case, setup) => {
    arrange(setup as Parameters<typeof arrange>[0]);

    await run();

    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("for a seat in a group class, emails only that seat's attendee (matching email case-insensitively)", async () => {
    arrange();
    findSeatAttendees.mockResolvedValue([{ email: "two@example.com" }]);

    await run({ bookingId: 10, paymentId: 99, attendeeSeatId: "seat-ref-2" });

    expect(findSeatAttendees).toHaveBeenCalledWith({ bookingId: 10, seatReferenceUid: "seat-ref-2" });
    expect(mockedSend).toHaveBeenCalledWith(
      expect.objectContaining({ attendees: [attendees[1]] }),
      expect.anything()
    );
    expect(createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({ name: "Seat Two" }));
  });

  it("sends nothing when the seat's attendee can't be found", async () => {
    arrange();
    findSeatAttendees.mockResolvedValue([]);

    await run({ bookingId: 10, paymentId: 99, attendeeSeatId: "seat-ref-gone" });

    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("defaults the payment option to ON_BOOKING", async () => {
    arrange({ payment: { uid: "payment-uid-1", success: false, paymentOption: null, amount: 1, currency: "czk" } });

    await run();

    expect(mockedSend).toHaveBeenCalledWith(
      expect.objectContaining({ paymentInfo: expect.objectContaining({ paymentOption: "ON_BOOKING" }) }),
      expect.anything()
    );
  });

  it("rejects a malformed task payload (so the tasker can report/retry it)", async () => {
    await expect(sendAwaitingPaymentEmail(JSON.stringify({ bookingId: "ten" }))).rejects.toThrow();
    expect(mockedSend).not.toHaveBeenCalled();
  });
});
