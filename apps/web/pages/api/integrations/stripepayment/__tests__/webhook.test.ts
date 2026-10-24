import type { NextApiRequest, NextApiResponse } from "next";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("raw-body", () => ({
  default: vi.fn(),
}));

vi.mock("@calcom/app-store/_utils/payments/handlePaymentSuccess", () => ({
  handlePaymentSuccess: vi.fn(),
}));

vi.mock("@calcom/app-store/stripepayment/lib/getStripeAppKeys", () => ({
  getStripeAppKeys: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({
  default: {
    payment: {
      findUnique: vi.fn(),
    },
  },
}));

const constructEventMock = vi.fn();
vi.mock("stripe", () => ({
  default: class MockStripe {
    webhooks = { constructEvent: constructEventMock };
  },
}));

import getRawBody from "raw-body";
import prisma from "@calcom/prisma";
import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import { getStripeAppKeys } from "@calcom/app-store/stripepayment/lib/getStripeAppKeys";
import { HttpError as HttpCode } from "@calcom/lib/http-error";

import handler, { getPaymentForStripeEvent } from "../webhook";

const mockGetRawBody = vi.mocked(getRawBody);
const mockHandlePaymentSuccess = vi.mocked(handlePaymentSuccess);
const mockGetStripeAppKeys = vi.mocked(getStripeAppKeys);
const mockPrisma = prisma as unknown as { payment: { findUnique: ReturnType<typeof vi.fn> } };

function createMockReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: "POST",
    headers: { "stripe-signature": "sig_test" },
    ...overrides,
  } as NextApiRequest;
}

function createMockRes() {
  const res: Partial<NextApiResponse> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as NextApiResponse["status"];
  res.send = vi.fn().mockImplementation((body: unknown) => {
    res.body = body;
    return res;
  }) as unknown as NextApiResponse["send"];
  res.end = vi.fn().mockImplementation(() => res) as unknown as NextApiResponse["end"];
  return res as NextApiResponse & { statusCode?: number; body?: unknown };
}

describe("Stripe webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRawBody.mockResolvedValue(Buffer.from("{}"));
    mockGetStripeAppKeys.mockResolvedValue({
      client_id: "ca_test",
      client_secret: "sk_test",
      public_key: "pk_test",
      webhook_secret: "whsec_test",
    });
  });

  it("rejects non-POST requests with 405", async () => {
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("rejects requests with no stripe-signature header with 400", async () => {
    const req = createMockReq({ headers: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects requests with an invalid signature with 400", async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 204 and does not confirm a booking for an unhandled event type", async () => {
    constructEventMock.mockReturnValue({
      type: "charge.refunded",
      data: { object: { id: "ch_123" } },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockPrisma.payment.findUnique).not.toHaveBeenCalled();
    expect(mockHandlePaymentSuccess).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("returns 204 when no Payment row matches the event's object id", async () => {
    constructEventMock.mockReturnValue({
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_unknown" } },
    });
    mockPrisma.payment.findUnique.mockResolvedValue(null);
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockPrisma.payment.findUnique).toHaveBeenCalledWith({
      where: { externalId: "pi_unknown" },
      select: { id: true, bookingId: true },
    });
    expect(mockHandlePaymentSuccess).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("confirms the booking on payment_intent.succeeded by looking up the Payment by externalId", async () => {
    constructEventMock.mockReturnValue({
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_123" } },
    });
    mockPrisma.payment.findUnique.mockResolvedValue({ id: 42, bookingId: 7 });
    mockHandlePaymentSuccess.mockRejectedValue(
      new HttpCode({ statusCode: 200, message: "Booking with id '7' was paid and confirmed." })
    );
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockHandlePaymentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 42, bookingId: 7, appSlug: "stripe" })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("confirms the booking on setup_intent.succeeded (HOLD / card-on-file flow)", async () => {
    constructEventMock.mockReturnValue({
      type: "setup_intent.succeeded",
      data: { object: { id: "seti_456" } },
    });
    mockPrisma.payment.findUnique.mockResolvedValue({ id: 99, bookingId: 11 });
    mockHandlePaymentSuccess.mockRejectedValue(
      new HttpCode({ statusCode: 200, message: "Booking with id '11' was paid and confirmed." })
    );
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockPrisma.payment.findUnique).toHaveBeenCalledWith({
      where: { externalId: "seti_456" },
      select: { id: true, bookingId: true },
    });
    expect(mockHandlePaymentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 99, bookingId: 11, appSlug: "stripe" })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("propagates the error status code when handlePaymentSuccess itself fails", async () => {
    constructEventMock.mockReturnValue({
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_789" } },
    });
    mockPrisma.payment.findUnique.mockResolvedValue({ id: 1, bookingId: 2 });
    mockHandlePaymentSuccess.mockRejectedValue(
      new HttpCode({ statusCode: 500, message: "Something went wrong" })
    );
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("getPaymentForStripeEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for an event type that is not handled", async () => {
    const result = await getPaymentForStripeEvent({
      type: "charge.refunded",
      data: { object: { id: "ch_1" } },
    } as never);

    expect(result).toBeNull();
    expect(mockPrisma.payment.findUnique).not.toHaveBeenCalled();
  });

  it("looks up the payment by the event object's id for a handled event type", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({ id: 5, bookingId: 6 });

    const result = await getPaymentForStripeEvent({
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_abc" } },
    } as never);

    expect(result).toEqual({ id: 5, bookingId: 6 });
    expect(mockPrisma.payment.findUnique).toHaveBeenCalledWith({
      where: { externalId: "pi_abc" },
      select: { id: true, bookingId: true },
    });
  });
});
