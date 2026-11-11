import prismock from "@calcom/testing/lib/__mocks__/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { completePaypalOrder } from "@calcom/app-store/paypal/lib/completePaypalOrder";

import handler from "./webhook";

const { verifyWebhook } = vi.hoisted(() => ({ verifyWebhook: vi.fn() }));

vi.mock("@calcom/app-store/paypal/lib/Paypal", () => ({
  default: class {
    getAccessToken = vi.fn();
    verifyWebhook = verifyWebhook;
  },
}));
vi.mock("@calcom/app-store/paypal/lib/completePaypalOrder", () => ({ completePaypalOrder: vi.fn() }));

const mockedCompletePaypalOrder = vi.mocked(completePaypalOrder);

const PAYPAL_HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.paypal.com/cert",
  "paypal-transmission-id": "transmission-1",
  "paypal-transmission-sig": "signature",
  "paypal-transmission-time": "2026-11-11T10:00:00Z",
};

function approvedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "WH-1",
    create_time: "2026-11-11T10:00:00Z",
    resource_type: "checkout-order",
    event_type: "CHECKOUT.ORDER.APPROVED",
    summary: "An order has been approved by buyer",
    event_version: "1.0",
    resource_version: "2.0",
    // No payer address: PayPal omits it for many payers, which used to make the webhook ignore the event.
    resource: { id: "ORDER_1", create_time: "2026-11-11T09:59:00Z", intent: "CAPTURE", status: "APPROVED" },
    ...overrides,
  };
}

async function post(body: unknown, headers: Record<string, string> = PAYPAL_HEADERS) {
  const raw = JSON.stringify(body);
  const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: "POST", headers });
  const res = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  };
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return { res, raw };
}

describe("PayPal webhook", () => {
  let bookingId: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    await prismock.payment.deleteMany();
    await prismock.booking.deleteMany();
    await prismock.credential.deleteMany();

    const booking = await prismock.booking.create({
      data: {
        uid: "booking-uid-1",
        title: "Sacred Geometry 1 Class",
        userId: 1,
        startTime: new Date("2026-12-01T10:00:00Z"),
        endTime: new Date("2026-12-01T14:30:00Z"),
      },
    });
    bookingId = booking.id;
    await prismock.payment.create({
      data: {
        uid: "payment-uid-1",
        appId: "paypal",
        bookingId,
        amount: 420000,
        fee: 0,
        currency: "CZK",
        success: false,
        refunded: false,
        data: {},
        externalId: "ORDER_1",
      },
    });
    await prismock.credential.create({
      data: {
        type: "paypal_payment",
        appId: "paypal",
        userId: 1,
        key: { client_id: "client", secret_key: "secret", webhook_id: "WEBHOOK_ID" },
      },
    });
    verifyWebhook.mockResolvedValue(undefined);
    mockedCompletePaypalOrder.mockResolvedValue({ status: "paid", paymentUid: "payment-uid-1" });
  });

  it("verifies the signature, then captures and confirms the approved order", async () => {
    const { res, raw } = await post(approvedEvent());

    expect(verifyWebhook).toHaveBeenCalledWith({
      body: {
        auth_algo: PAYPAL_HEADERS["paypal-auth-algo"],
        cert_url: PAYPAL_HEADERS["paypal-cert-url"],
        transmission_id: PAYPAL_HEADERS["paypal-transmission-id"],
        transmission_sig: PAYPAL_HEADERS["paypal-transmission-sig"],
        transmission_time: PAYPAL_HEADERS["paypal-transmission-time"],
        webhook_id: "WEBHOOK_ID",
        webhook_event: raw,
      },
    });
    expect(mockedCompletePaypalOrder).toHaveBeenCalledWith({
      orderId: "ORDER_1",
      credentials: { clientId: "client", secretKey: "secret" },
      expectedBookingId: bookingId,
      source: "webhook",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.end).toHaveBeenCalled();
  });

  it("ignores an event whose signature doesn't verify", async () => {
    verifyWebhook.mockRejectedValue(new Error("verification_status FAILURE"));

    const { res } = await post(approvedEvent());

    expect(mockedCompletePaypalOrder).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("ignores requests without PayPal's signature headers", async () => {
    await post(approvedEvent(), {});

    expect(verifyWebhook).not.toHaveBeenCalled();
    expect(mockedCompletePaypalOrder).not.toHaveBeenCalled();
  });

  it("ignores other event types", async () => {
    await post(approvedEvent({ event_type: "CHECKOUT.ORDER.COMPLETED" }));

    expect(mockedCompletePaypalOrder).not.toHaveBeenCalled();
  });

  it("ignores orders it doesn't know", async () => {
    await post(approvedEvent({ resource: { id: "SOMEONE_ELSES_ORDER", create_time: "2026-11-11T09:59:00Z" } }));

    expect(verifyWebhook).not.toHaveBeenCalled();
    expect(mockedCompletePaypalOrder).not.toHaveBeenCalled();
  });

  it("rejects non-POST requests", async () => {
    const req = Object.assign(Readable.from([]), { method: "GET", headers: PAYPAL_HEADERS });
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), end: vi.fn() };

    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(mockedCompletePaypalOrder).not.toHaveBeenCalled();
  });
});
