import type { GetServerSidePropsContext } from "next";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@calcom/prisma", () => ({
  default: {
    payment: {
      findUnique: vi.fn(),
    },
  },
}));

import prisma from "@calcom/prisma";

import { getServerSideProps } from "../page";

const mockPrisma = prisma as unknown as { payment: { findUnique: ReturnType<typeof vi.fn> } };

function createMockContext(uid?: string): GetServerSidePropsContext {
  return {
    params: uid === undefined ? {} : { uid },
    query: {},
    req: {} as GetServerSidePropsContext["req"],
    res: {} as GetServerSidePropsContext["res"],
    resolvedUrl: "/payment/test",
  } as unknown as GetServerSidePropsContext;
}

const basePaymentRow = {
  id: 1,
  success: false,
  refunded: false,
  amount: 10000,
  currency: "czk",
  paymentOption: "ON_BOOKING",
  data: { id: "pi_123", client_secret: "pi_123_secret" },
  appId: "stripe",
  booking: {
    id: 55,
    uid: "booking-uid-123",
    title: "Aura Healing",
    description: null,
    startTime: new Date("2026-11-01T10:00:00.000Z"),
    endTime: new Date("2026-11-01T11:00:00.000Z"),
    status: "PENDING",
    paid: false,
    location: null,
    attendees: [{ email: "booker@example.com" }],
    user: { name: "Radu", username: "radu", theme: null, hideBranding: false },
    eventType: {
      id: 7,
      title: "Aura Healing",
      length: 60,
      price: 10000,
      currency: "czk",
      metadata: null,
      successRedirectUrl: null,
      forwardParamsSuccessRedirect: null,
      recurringEvent: null,
    },
  },
};

describe("payment page getServerSideProps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns notFound when uid param is missing", async () => {
    const result = await getServerSideProps(createMockContext(undefined));

    expect(result).toEqual({ notFound: true });
    expect(mockPrisma.payment.findUnique).not.toHaveBeenCalled();
  });

  it("returns notFound when no payment matches the uid", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(null);

    const result = await getServerSideProps(createMockContext("missing-uid"));

    expect(result).toEqual({ notFound: true });
  });

  it("returns notFound when the payment has no linked booking", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({ ...basePaymentRow, booking: null });

    const result = await getServerSideProps(createMockContext("orphan-uid"));

    expect(result).toEqual({ notFound: true });
  });

  it("builds props from a real payment+booking row, including the Stripe client secret", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(basePaymentRow);

    const result = await getServerSideProps(createMockContext("payment-uid-123"));

    expect(mockPrisma.payment.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { uid: "payment-uid-123" } })
    );
    expect(result).toHaveProperty("props");
    const props = (result as { props: Record<string, unknown> }).props;
    expect(props.clientSecret).toBe("pi_123_secret");
    expect(props.payment).toMatchObject({ id: 1, appId: "stripe", paymentOption: "ON_BOOKING" });
    expect(props.booking).toMatchObject({
      id: 55,
      uid: "booking-uid-123",
      attendeeEmail: "booker@example.com",
    });
    expect(props.eventType).toMatchObject({ id: 7, title: "Aura Healing", length: 60 });
    expect(props.user).toEqual({ name: "Radu", username: "radu" });
  });

  it("falls back to null attendeeEmail when the booking has no attendees", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({
      ...basePaymentRow,
      booking: { ...basePaymentRow.booking, attendees: [] },
    });

    const result = await getServerSideProps(createMockContext("payment-uid-123"));

    const props = (result as { props: Record<string, unknown> }).props;
    expect((props.booking as { attendeeEmail: unknown }).attendeeEmail).toBeNull();
  });

  it("returns a null clientSecret for a HOLD payment whose data doesn't match the expected shape yet", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({
      ...basePaymentRow,
      paymentOption: "HOLD",
      data: { stripe_publishable_key: "pk_test" },
    });

    const result = await getServerSideProps(createMockContext("payment-uid-123"));

    const props = (result as { props: Record<string, unknown> }).props;
    expect(props.clientSecret).toBeNull();
  });
});
