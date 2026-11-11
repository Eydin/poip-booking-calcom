/**
 * Integration tests (in-memory DB via prismock) for the "paymentMethod" booking field on a
 * Stripe-priced event type: card (Stripe), PayPal or bank transfer (QR code), for normal events
 * and seated events (group classes, where every attendee shares one booking). Checks which
 * payment app's service is asked to create the payment and with what amount/currency, and where
 * the bank-transfer details are stored - the PayPal service itself is covered by
 * app-store/paypal's tests.
 */
import { appStoreMetadata } from "@calcom/app-store/appStoreMetaData";
import { PaymentServiceMap } from "@calcom/app-store/payment.services.generated";
import prismaMock from "@calcom/testing/lib/__mocks__/prisma";
import {
  BookingLocations,
  createBookingScenario,
  getBooker,
  getDate,
  getDefaultBookingFields,
  getMockBookingAttendee,
  getGoogleCalendarCredential,
  getMockedCredential,
  getOrganizer,
  getScenarioData,
  getStripeAppCredential,
  mockCalendarToHaveNoBusySlots,
  mockSuccessfulVideoMeetingCreation,
  TestData,
} from "@calcom/testing/lib/bookingScenario/bookingScenario";
import { getMockRequestDataForBooking } from "@calcom/testing/lib/bookingScenario/getMockRequestDataForBooking";
import { setupAndTeardown } from "@calcom/testing/lib/bookingScenario/setupAndTeardown";
import { test } from "@calcom/testing/lib/fixtures/fixtures";
import type { Fields } from "@calcom/features/bookings/lib/getBookingFields";
import { BookingStatus } from "@calcom/prisma/enums";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { getNewBookingHandler } from "./getNewBookingHandler";

const timeout = process.env.CI ? 5000 : 20000;

const paymentMethodField = {
  name: "paymentMethod",
  type: "select",
  label: "How would you like to pay?",
  required: true,
  options: [
    { label: "Pay online now (card)", value: "stripe" },
    { label: "Pay with PayPal", value: "paypal" },
    { label: "Pay by bank transfer (QR code)", value: "bank_transfer" },
  ],
  sources: [{ id: "user", type: "user", label: "User", fieldRequired: true }],
} as unknown as Fields[number];

const paymentChoiceField = {
  name: "paymentChoice",
  type: "select",
  label: "Pay in full or just the deposit?",
  required: true,
  options: [
    { label: "Deposit - 12,000 CZK now", value: "deposit", price: 0 },
    { label: "Pay in full - 36,500 CZK now", value: "full", price: 24500 },
  ],
  sources: [{ id: "user", type: "user", label: "User", fieldRequired: true }],
} as unknown as Fields[number];

type CreatedPayment ={ dirName: string; amount: number; currency: string; paymentOption: string };

/**
 * Swaps the (globally mocked) Stripe and PayPal payment services for recorders, so a test can
 * see which one handled the booking.
 */
function recordPaymentServices() {
  const created: CreatedPayment[] = [];
  const map = PaymentServiceMap as unknown as Record<string, Promise<unknown>>;
  for (const dirName of ["stripepayment", "paypal"]) {
    map[dirName] = Promise.resolve({
      BuildPaymentService: () => ({
        create: async (
          payment: { amount: number; currency: string },
          bookingId: number,
          _userId: number,
          _username: string | null,
          _bookerName: string,
          paymentOption: string
        ) => {
          created.push({ dirName, amount: payment.amount, currency: payment.currency, paymentOption });
          return prismaMock.payment.create({
            data: {
              uid: `${dirName}-payment-uid`,
              appId: null,
              bookingId,
              fee: 0,
              success: false,
              refunded: false,
              data: {},
              externalId: `${dirName}-external-id`,
              paymentOption,
              amount: payment.amount,
              currency: payment.currency,
            },
          });
        },
        afterPayment: async () => undefined,
      }),
    });
  }
  return created;
}

const SEATED_BOOKING_UID = "seated-booking-uid";

/** An existing booking on a seated event with one seat already taken (like Sacred Geometry 1). */
function existingSeatedBooking() {
  const { dateString: plus1DateString } = getDate({ dateIncrement: 1 });
  return {
    id: 1,
    uid: SEATED_BOOKING_UID,
    eventTypeId: 1,
    status: BookingStatus.ACCEPTED,
    startTime: `${plus1DateString}T04:00:00Z`,
    endTime: `${plus1DateString}T04:30:00Z`,
    attendees: [
      getMockBookingAttendee({
        id: 1,
        name: "Seat 1",
        email: "seat1@test.com",
        locale: "en",
        timeZone: "Europe/Prague",
        bookingSeat: { referenceUid: "booking-seat-1", data: {} },
      }),
    ],
  };
}

async function setupPaidEvent({
  withPaypal = true,
  paymentOption = "ON_BOOKING",
  seated = false,
  // For seated events: whether someone has already booked the slot (so new bookers join it).
  existingSeatedBookingInSlot = true,
  // Like Empower Thyself: a 12,000 CZK deposit, or +24,500 CZK via "paymentChoice" to pay in full.
  depositOrFull = false,
} = {}) {
  const organizer = getOrganizer({
    name: "Organizer",
    email: "organizer@example.com",
    id: 101,
    schedules: [TestData.schedules.IstWorkHours],
    credentials: [
      getGoogleCalendarCredential(),
      getStripeAppCredential(),
      ...(withPaypal ? [getMockedCredential({ metadataLookupKey: "paypal", key: { scope: "read_write" } })] : []),
    ],
    selectedCalendars: [TestData.selectedCalendars.google],
  });

  await createBookingScenario(
    getScenarioData({
      eventTypes: [
        {
          id: 1,
          title: "Sacred Geometry 1 Class",
          slotInterval: 30,
          length: 30,
          requiresConfirmation: false,
          metadata: {
            apps: {
              // Event types are priced through Stripe; PayPal is only offered via paymentMethod.
              stripe: {
                price: depositOrFull ? 1200000 : 420000,
                enabled: true,
                currency: "czk",
                paymentOption,
              },
            },
          },
          bookingFields: getDefaultBookingFields({
            bookingFields: depositOrFull ? [paymentMethodField, paymentChoiceField] : [paymentMethodField],
          }),
          users: [{ id: 101 }],
          ...(seated ? { seatsPerTimeSlot: 3, seatsShowAttendees: false } : {}),
        },
      ],
      ...(seated && existingSeatedBookingInSlot ? { bookings: [existingSeatedBooking()] } : {}),
      organizer,
      apps: [
        TestData.apps["google-calendar"],
        TestData.apps["daily-video"],
        TestData.apps["stripe-payment"],
        { ...appStoreMetadata.paypal, keys: {} },
      ],
    })
  );
  mockSuccessfulVideoMeetingCreation({ metadataLookupKey: "dailyvideo" });
  mockCalendarToHaveNoBusySlots("googlecalendar");
}

function bookWith(
  paymentMethod: string,
  {
    joinSeatedBooking = false,
    bookerEmail = "booker@example.com",
    paymentChoice,
  }: { joinSeatedBooking?: boolean; bookerEmail?: string; paymentChoice?: "deposit" | "full" } = {}
) {
  const booker = getBooker({ email: bookerEmail, name: "Booker" });
  return getNewBookingHandler()({
    bookingData: getMockRequestDataForBooking({
      data: {
        eventTypeId: 1,
        responses: {
          email: booker.email,
          name: booker.name,
          location: { optionValue: "", value: BookingLocations.CalVideo },
          paymentMethod,
          ...(paymentChoice ? { paymentChoice } : {}),
        },
        ...(joinSeatedBooking ? { bookingUid: SEATED_BOOKING_UID, user: "seatedAttendee" } : {}),
      },
    }),
  });
}

const BANK_IBAN = "CZ6508000000192000145399";

const BANK_TRANSFER_KEYS = [
  "bankTransferSpayd",
  "bankTransferIban",
  "bankTransferAccountHolderName",
  "bankTransferVariableSymbol",
  "bankTransferAmount",
  "bankTransferCurrency",
];

async function findSeatOf(email: string) {
  const attendee = await prismaMock.attendee.findFirst({ where: { email } });
  const seat = attendee
    ? await prismaMock.bookingSeat.findFirst({ where: { attendeeId: attendee.id } })
    : null;
  return { attendee, seat };
}

describe("handleNewBooking: bank-transfer details", () => {
  setupAndTeardown();

  beforeEach(() => {
    vi.stubEnv("BANK_TRANSFER_IBAN", BANK_IBAN);
    vi.stubEnv("BANK_TRANSFER_ACCOUNT_HOLDER_NAME", "Test Holder");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test(
    "a normal booking keeps its QR on the booking, referenced by the booking id",
    async () => {
      await setupPaidEvent();
      const created = recordPaymentServices();

      const result = await bookWith("bank_transfer");

      expect(created).toEqual([]);
      const booking = await prismaMock.booking.findUnique({ where: { uid: result.uid } });
      expect(booking?.status).toBe(BookingStatus.PENDING);
      expect(booking?.metadata).toMatchObject({
        bankTransferIban: BANK_IBAN,
        bankTransferAccountHolderName: "Test Holder",
        bankTransferVariableSymbol: String(booking?.id),
        bankTransferAmount: "4200.00",
        bankTransferCurrency: "CZK",
        bankTransferSpayd: expect.stringContaining(`X-VS:${booking?.id}`),
      });
    },
    timeout
  );

  test(
    "fails clearly when bank transfer isn't configured",
    async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("BANK_TRANSFER_IBAN", "");
      await setupPaidEvent();
      recordPaymentServices();

      await expect(bookWith("bank_transfer")).rejects.toMatchObject({
        statusCode: 400,
        message: "Bank transfer payment is not configured",
      });
    },
    timeout
  );

  test(
    "the first person booking a group class gets the QR on their own seat, not on the shared booking",
    async () => {
      await setupPaidEvent({ seated: true, existingSeatedBookingInSlot: false });
      const created = recordPaymentServices();

      const result = await bookWith("bank_transfer");

      expect(created).toEqual([]);
      const { attendee, seat } = await findSeatOf("booker@example.com");
      expect(seat?.metadata).toMatchObject({
        bankTransferVariableSymbol: String(attendee?.id),
        bankTransferSpayd: expect.stringContaining(`X-VS:${attendee?.id}`),
        bankTransferAmount: "4200.00",
      });
      const booking = await prismaMock.booking.findUnique({ where: { uid: result.uid } });
      for (const key of BANK_TRANSFER_KEYS) {
        expect(booking?.metadata ?? {}).not.toHaveProperty(key);
      }
    },
    timeout
  );

  test(
    "people joining a group class by bank transfer each get their own QR and reference number",
    async () => {
      await setupPaidEvent({ seated: true });
      recordPaymentServices();

      await bookWith("bank_transfer", { joinSeatedBooking: true, bookerEmail: "seat2@example.com" });
      await bookWith("bank_transfer", { joinSeatedBooking: true, bookerEmail: "seat3@example.com" });

      const second = await findSeatOf("seat2@example.com");
      const third = await findSeatOf("seat3@example.com");
      const secondVs = (second.seat?.metadata as Record<string, string>)?.bankTransferVariableSymbol;
      const thirdVs = (third.seat?.metadata as Record<string, string>)?.bankTransferVariableSymbol;
      expect(secondVs).toBe(String(second.attendee?.id));
      expect(thirdVs).toBe(String(third.attendee?.id));
      expect(secondVs).not.toBe(thirdVs);

      // Nothing on the shared booking - other attendees (incl. card payers) never see these.
      const booking = await prismaMock.booking.findUnique({ where: { uid: SEATED_BOOKING_UID } });
      for (const key of BANK_TRANSFER_KEYS) {
        expect(booking?.metadata ?? {}).not.toHaveProperty(key);
      }
      // The attendee who was already booked is untouched.
      const first = await prismaMock.bookingSeat.findFirst({ where: { referenceUid: "booking-seat-1" } });
      expect(first?.metadata ?? {}).not.toHaveProperty("bankTransferSpayd");
    },
    timeout
  );

  test(
    "a person joining a group class by card gets no QR",
    async () => {
      await setupPaidEvent({ seated: true });
      const created = recordPaymentServices();

      await bookWith("stripe", { joinSeatedBooking: true });

      expect(created).toHaveLength(1);
      const { seat } = await findSeatOf("booker@example.com");
      expect(seat?.metadata ?? {}).not.toHaveProperty("bankTransferSpayd");
    },
    timeout
  );
});

describe("handleNewBooking: paying with PayPal instead of the event type's Stripe price", () => {
  setupAndTeardown();

  test(
    "routes the payment to PayPal at the Stripe price, in upper-case currency, and leaves the booking awaiting payment",
    async () => {
      await setupPaidEvent();
      const created = recordPaymentServices();

      const booking = await bookWith("paypal");

      expect(created).toEqual([
        { dirName: "paypal", amount: 420000, currency: "CZK", paymentOption: "ON_BOOKING" },
      ]);
      expect(booking.paymentUid).toBe("paypal-payment-uid");
      const stored = await prismaMock.booking.findUnique({ where: { uid: booking.uid } });
      expect(stored?.status).toBe(BookingStatus.PENDING);
      expect(stored?.paid).toBe(false);
    },
    timeout
  );

  test(
    "still uses Stripe when the booker picks card",
    async () => {
      await setupPaidEvent();
      const created = recordPaymentServices();

      const booking = await bookWith("stripe");

      expect(created).toEqual([
        { dirName: "stripepayment", amount: 420000, currency: "czk", paymentOption: "ON_BOOKING" },
      ]);
      expect(booking.paymentUid).toBe("stripepayment-payment-uid");
    },
    timeout
  );

  test(
    "rejects PayPal with a clear error when the organizer hasn't connected PayPal",
    async () => {
      await setupPaidEvent({ withPaypal: false });
      const created = recordPaymentServices();

      await expect(bookWith("paypal")).rejects.toMatchObject({
        statusCode: 400,
        message: "PayPal payment is not configured",
      });
      expect(created).toEqual([]);
    },
    timeout
  );

  test(
    "routes a new seat on a seated event (e.g. a group class) to PayPal too",
    async () => {
      await setupPaidEvent({ seated: true });
      const created = recordPaymentServices();

      const result = await bookWith("paypal", { joinSeatedBooking: true });

      expect(created).toEqual([
        { dirName: "paypal", amount: 420000, currency: "CZK", paymentOption: "ON_BOOKING" },
      ]);
      expect(result.paymentUid).toBe("paypal-payment-uid");
      // The seat was added to the existing booking rather than creating a new one.
      const seat = await prismaMock.attendee.findFirst({
        where: { email: "booker@example.com", bookingId: 1 },
      });
      expect(seat).not.toBeNull();
    },
    timeout
  );

  test(
    "a new seat paying by card still goes through Stripe",
    async () => {
      await setupPaidEvent({ seated: true });
      const created = recordPaymentServices();

      await bookWith("stripe", { joinSeatedBooking: true });

      expect(created).toEqual([
        { dirName: "stripepayment", amount: 420000, currency: "czk", paymentOption: "ON_BOOKING" },
      ]);
    },
    timeout
  );

  test(
    "the first person booking a group class can pay with PayPal",
    async () => {
      await setupPaidEvent({ seated: true, existingSeatedBookingInSlot: false });
      const created = recordPaymentServices();

      const result = await bookWith("paypal");

      expect(created).toEqual([
        { dirName: "paypal", amount: 420000, currency: "CZK", paymentOption: "ON_BOOKING" },
      ]);
      expect(result.paymentUid).toBe("paypal-payment-uid");
    },
    timeout
  );

  test(
    "rejects PayPal for events that hold a card for a later charge",
    async () => {
      await setupPaidEvent({ paymentOption: "HOLD" });
      const created = recordPaymentServices();

      await expect(bookWith("paypal")).rejects.toMatchObject({
        statusCode: 400,
        message: "PayPal is not available for this event",
      });
      expect(created).toEqual([]);
    },
    timeout
  );
});

describe("handleNewBooking: 'deposit or pay in full' events charge the same amount by every method", () => {
  setupAndTeardown();

  beforeEach(() => {
    vi.stubEnv("BANK_TRANSFER_IBAN", BANK_IBAN);
    vi.stubEnv("BANK_TRANSFER_ACCOUNT_HOLDER_NAME", "Test Holder");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test.each([
    ["stripe", "full", { dirName: "stripepayment", amount: 3650000, currency: "czk" }],
    ["stripe", "deposit", { dirName: "stripepayment", amount: 1200000, currency: "czk" }],
    ["paypal", "full", { dirName: "paypal", amount: 3650000, currency: "CZK" }],
    ["paypal", "deposit", { dirName: "paypal", amount: 1200000, currency: "CZK" }],
  ] as const)(
    "%s, %s: charges the chosen amount online",
    async (paymentMethod, paymentChoice, expected) => {
      await setupPaidEvent({ depositOrFull: true });
      const created = recordPaymentServices();

      await bookWith(paymentMethod, { paymentChoice });

      expect(created).toEqual([{ ...expected, paymentOption: "ON_BOOKING" }]);
    },
    timeout
  );

  test.each([
    ["full", "36500.00"],
    ["deposit", "12000.00"],
  ] as const)(
    "bank transfer, %s: the QR code asks for the chosen amount",
    async (paymentChoice, expectedAmount) => {
      await setupPaidEvent({ depositOrFull: true });
      recordPaymentServices();

      const result = await bookWith("bank_transfer", { paymentChoice });

      const booking = await prismaMock.booking.findUnique({ where: { uid: result.uid } });
      expect(booking?.metadata).toMatchObject({
        bankTransferAmount: expectedAmount,
        bankTransferCurrency: "CZK",
        bankTransferSpayd: expect.stringContaining(`*AM:${expectedAmount}*CC:CZK*`),
      });
    },
    timeout
  );

  test(
    "bank transfer on a seated event (Empower Thyself is one), joining as a later attendee: full amount on their seat",
    async () => {
      await setupPaidEvent({ depositOrFull: true, seated: true });
      recordPaymentServices();

      await bookWith("bank_transfer", { joinSeatedBooking: true, paymentChoice: "full" });

      const { seat } = await findSeatOf("booker@example.com");
      expect(seat?.metadata).toMatchObject({
        bankTransferAmount: "36500.00",
        bankTransferSpayd: expect.stringContaining("*AM:36500.00*CC:CZK*"),
      });
    },
    timeout
  );

  test(
    "bank transfer on a seated event, as the first attendee: full amount on their seat",
    async () => {
      await setupPaidEvent({ depositOrFull: true, seated: true, existingSeatedBookingInSlot: false });
      recordPaymentServices();

      await bookWith("bank_transfer", { paymentChoice: "full" });

      const { seat } = await findSeatOf("booker@example.com");
      expect(seat?.metadata).toMatchObject({ bankTransferAmount: "36500.00" });
    },
    timeout
  );

  test(
    "a seat joined with PayPal and 'pay in full' is charged the full amount",
    async () => {
      await setupPaidEvent({ depositOrFull: true, seated: true });
      const created = recordPaymentServices();

      await bookWith("paypal", { joinSeatedBooking: true, paymentChoice: "full" });

      expect(created).toEqual([
        { dirName: "paypal", amount: 3650000, currency: "CZK", paymentOption: "ON_BOOKING" },
      ]);
    },
    timeout
  );
});
