import prismock from "@calcom/testing/lib/__mocks__/prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";

import tasker from "@calcom/features/tasker";

import { BuildPaymentService } from "./PaymentService";

const { createOrder, getOrder, refundCapture } = vi.hoisted(() => ({
  createOrder: vi.fn(),
  getOrder: vi.fn(),
  refundCapture: vi.fn(),
}));

vi.mock("./Paypal", () => ({
  default: class {
    createOrder = createOrder;
    getOrder = getOrder;
    refundCapture = refundCapture;
  },
}));

vi.mock("@calcom/features/tasker", () => ({ default: { create: vi.fn() } }));

const service = () =>
  BuildPaymentService({ key: { client_id: "client", secret_key: "secret", webhook_id: "wh" } });

async function seedPayment(overrides: Record<string, unknown> = {}) {
  return prismock.payment.create({
    data: {
      uid: "payment-uid-1",
      appId: "paypal",
      bookingId: 10,
      amount: 420000,
      fee: 0,
      currency: "CZK",
      success: true,
      refunded: false,
      data: { order: { id: "ORDER_1" }, captureId: "CAPTURE_1" },
      externalId: "ORDER_1",
      ...overrides,
    },
  });
}

describe("PayPal PaymentService.refund", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await prismock.payment.deleteMany();
    refundCapture.mockResolvedValue(true);
  });

  it("refunds the stored capture and marks the payment refunded", async () => {
    const payment = await seedPayment();

    const refunded = await service().refund(payment.id);

    expect(refundCapture).toHaveBeenCalledWith("CAPTURE_1");
    expect(getOrder).not.toHaveBeenCalled();
    expect(refunded?.refunded).toBe(true);
    expect((await prismock.payment.findUnique({ where: { id: payment.id } }))?.refunded).toBe(true);
  });

  it("looks the capture up on the order when it wasn't stored", async () => {
    const payment = await seedPayment({ data: { order: { id: "ORDER_1" } } });
    getOrder.mockResolvedValue({
      id: "ORDER_1",
      status: "COMPLETED",
      purchase_units: [{ payments: { captures: [{ id: "CAPTURE_FROM_ORDER", status: "COMPLETED" }] } }],
    });

    await service().refund(payment.id);

    expect(getOrder).toHaveBeenCalledWith("ORDER_1");
    expect(refundCapture).toHaveBeenCalledWith("CAPTURE_FROM_ORDER");
  });

  it("returns null for an unknown payment", async () => {
    expect(await service().refund(12345)).toBeNull();
    expect(refundCapture).not.toHaveBeenCalled();
  });

  it("refuses to refund a payment that never succeeded", async () => {
    const payment = await seedPayment({ success: false });

    await expect(service().refund(payment.id)).rejects.toThrow("Unable to refund failed payment");
    expect(refundCapture).not.toHaveBeenCalled();
  });

  it("is a no-op for an already-refunded payment", async () => {
    const payment = await seedPayment({ refunded: true });

    const result = await service().refund(payment.id);

    expect(result?.refunded).toBe(true);
    expect(refundCapture).not.toHaveBeenCalled();
  });

  it("fails (and leaves the payment unrefunded) when no capture can be found", async () => {
    const payment = await seedPayment({ data: {} });
    getOrder.mockResolvedValue({ id: "ORDER_1", status: "APPROVED" });

    await expect(service().refund(payment.id)).rejects.toThrow(/no capture found/);
    expect((await prismock.payment.findUnique({ where: { id: payment.id } }))?.refunded).toBe(false);
  });

  it("fails (and leaves the payment unrefunded) when PayPal rejects the refund", async () => {
    const payment = await seedPayment();
    refundCapture.mockResolvedValue(false);

    await expect(service().refund(payment.id)).rejects.toThrow(/refund failed/);
    expect((await prismock.payment.findUnique({ where: { id: payment.id } }))?.refunded).toBe(false);
  });

  it("fails without credentials", async () => {
    const payment = await seedPayment();
    const withoutCredentials = BuildPaymentService({ key: {} });

    await expect(withoutCredentials.refund(payment.id)).rejects.toThrow(/credentials/);
    expect(refundCapture).not.toHaveBeenCalled();
  });
});

describe("PayPal PaymentService.create", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await prismock.payment.deleteMany();
    await prismock.booking.deleteMany();
  });

  async function seedBooking() {
    return prismock.booking.create({
      data: {
        uid: "booking-uid-1",
        title: "Sacred Geometry 1 Class between Radu and Booker",
        startTime: new Date("2026-12-01T10:00:00Z"),
        endTime: new Date("2026-12-01T14:30:00Z"),
      },
    });
  }

  it("creates a PayPal order that returns to the capture endpoint, and records the payment", async () => {
    const booking = await seedBooking();
    createOrder.mockResolvedValue({
      id: "ORDER_NEW",
      status: "PAYER_ACTION_REQUIRED",
      links: [{ href: "https://paypal.example/approve", rel: "payer-action", method: "GET" }],
    });

    const payment = await service().create({ amount: 420000, currency: "CZK" }, booking.id);

    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 420000,
        currency: "CZK",
        description: booking.title,
        returnUrl: expect.stringContaining(`/api/integrations/paypal/capture?bookingUid=${booking.uid}`),
        cancelUrl: expect.stringContaining(`/payment/${payment.uid}`),
      })
    );
    expect(payment).toMatchObject({
      externalId: "ORDER_NEW",
      amount: 420000,
      currency: "CZK",
      success: false,
      bookingId: booking.id,
    });
  });

  it("fails instead of recording a payment PayPal never created", async () => {
    const booking = await seedBooking();
    createOrder.mockResolvedValue({});

    await expect(service().create({ amount: 420000, currency: "CZK" }, booking.id)).rejects.toThrow();
    expect(await prismock.payment.count()).toBe(0);
  });
});

describe("PayPal PaymentService.afterPayment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("schedules the 'awaiting payment' reminder email, like Stripe does", async () => {
    const before = Date.now();

    await service().afterPayment(
      { attendeeSeatId: "seat-ref-1" } as never,
      { id: 10, uid: "booking-uid-1" } as never,
      { id: 99 } as never
    );

    expect(tasker.create).toHaveBeenCalledTimes(1);
    const [taskName, payload, options] = vi.mocked(tasker.create).mock.calls[0];
    expect(taskName).toBe("sendAwaitingPaymentEmail");
    expect(payload).toEqual({ bookingId: 10, paymentId: 99, attendeeSeatId: "seat-ref-1" });
    // referenceUid lets handlePaymentSuccess cancel it once the booker pays.
    expect(options).toMatchObject({ referenceUid: "booking-uid-1" });
    const scheduledAt = (options as { scheduledAt: Date }).scheduledAt.getTime();
    expect(scheduledAt - before).toBeGreaterThanOrEqual(15 * 60 * 1000 - 1000);
    expect(scheduledAt - before).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);
  });
});
