import prismock from "@calcom/testing/lib/__mocks__/prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import { HttpError } from "@calcom/lib/http-error";

import { completePaypalOrder } from "./completePaypalOrder";

const { captureOrder } = vi.hoisted(() => ({ captureOrder: vi.fn() }));

vi.mock("./Paypal", () => ({
  default: class {
    captureOrder = captureOrder;
  },
}));

vi.mock("@calcom/app-store/_utils/payments/handlePaymentSuccess", () => ({
  handlePaymentSuccess: vi.fn(),
}));

const mockedHandlePaymentSuccess = vi.mocked(handlePaymentSuccess);

const credentials = { clientId: "client", secretKey: "secret" };
const ORDER_ID = "ORDER_1";
const BOOKING_ID = 10;

async function seedPayment(overrides: Record<string, unknown> = {}) {
  return prismock.payment.create({
    data: {
      uid: "payment-uid-1",
      appId: "paypal",
      bookingId: BOOKING_ID,
      amount: 420000,
      fee: 0,
      currency: "CZK",
      success: false,
      refunded: false,
      data: { order: { id: ORDER_ID, status: "PAYER_ACTION_REQUIRED" } },
      externalId: ORDER_ID,
      ...overrides,
    },
  });
}

// handlePaymentSuccess signals success by throwing a 200 HttpError.
const confirmedBooking = () =>
  new HttpError({ statusCode: 200, message: `Booking with id '${BOOKING_ID}' was paid and confirmed.` });

describe("completePaypalOrder", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await prismock.payment.deleteMany();
    captureOrder.mockResolvedValue({ captureId: "CAPTURE_1" });
    mockedHandlePaymentSuccess.mockRejectedValue(confirmedBooking());
  });

  it("captures the order, stores the capture id and confirms the booking", async () => {
    const payment = await seedPayment();

    const result = await completePaypalOrder({ orderId: ORDER_ID, credentials, source: "return" });

    expect(result).toEqual({ status: "paid", paymentUid: "payment-uid-1" });
    expect(captureOrder).toHaveBeenCalledWith(ORDER_ID);
    expect(mockedHandlePaymentSuccess).toHaveBeenCalledTimes(1);
    expect(mockedHandlePaymentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: payment.id, bookingId: BOOKING_ID, appSlug: "paypal" })
    );

    const updated = await prismock.payment.findUnique({ where: { id: payment.id } });
    expect(updated?.success).toBe(true);
    // The capture id is added next to the existing order data (needed for refunds).
    expect(updated?.data).toEqual({
      order: { id: ORDER_ID, status: "PAYER_ACTION_REQUIRED" },
      captureId: "CAPTURE_1",
    });
  });

  it("also counts as paid if handlePaymentSuccess returns normally", async () => {
    await seedPayment();
    mockedHandlePaymentSuccess.mockResolvedValue(undefined as never);

    const result = await completePaypalOrder({ orderId: ORDER_ID, credentials, source: "webhook" });

    expect(result.status).toBe("paid");
  });

  it("does nothing for an order with no matching PayPal payment", async () => {
    // A Stripe payment that happens to share the external id must not be touched.
    await seedPayment({ appId: "stripe" });

    const result = await completePaypalOrder({ orderId: ORDER_ID, credentials, source: "webhook" });

    expect(result).toEqual({ status: "payment_not_found" });
    expect(captureOrder).not.toHaveBeenCalled();
    expect(mockedHandlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("refuses an order that belongs to a different booking", async () => {
    await seedPayment();

    const result = await completePaypalOrder({
      orderId: ORDER_ID,
      credentials,
      expectedBookingId: BOOKING_ID + 1,
      source: "return",
    });

    expect(result).toEqual({ status: "payment_not_found" });
    expect(captureOrder).not.toHaveBeenCalled();
  });

  it("doesn't capture or confirm again when the payment already succeeded", async () => {
    await seedPayment({ success: true });

    const result = await completePaypalOrder({ orderId: ORDER_ID, credentials, source: "webhook" });

    expect(result).toEqual({ status: "already_paid", paymentUid: "payment-uid-1" });
    expect(captureOrder).not.toHaveBeenCalled();
    expect(mockedHandlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("leaves the payment unpaid when the capture doesn't complete", async () => {
    const payment = await seedPayment();
    captureOrder.mockResolvedValue(null);

    const result = await completePaypalOrder({ orderId: ORDER_ID, credentials, source: "return" });

    expect(result).toEqual({ status: "not_completed", paymentUid: "payment-uid-1" });
    expect(mockedHandlePaymentSuccess).not.toHaveBeenCalled();
    const unchanged = await prismock.payment.findUnique({ where: { id: payment.id } });
    expect(unchanged?.success).toBe(false);
  });

  it("confirms the booking only once when the return and the webhook race", async () => {
    await seedPayment();

    const results = await Promise.all([
      completePaypalOrder({ orderId: ORDER_ID, credentials, source: "return" }),
      completePaypalOrder({ orderId: ORDER_ID, credentials, source: "webhook" }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["already_paid", "paid"]);
    expect(mockedHandlePaymentSuccess).toHaveBeenCalledTimes(1);
  });

  it("rethrows a real confirmation failure and keeps the payment marked as captured", async () => {
    const payment = await seedPayment();
    mockedHandlePaymentSuccess.mockRejectedValue(new Error("calendar down"));

    await expect(
      completePaypalOrder({ orderId: ORDER_ID, credentials, source: "return" })
    ).rejects.toThrow("calendar down");

    // Money was taken: the claim stays so a later webhook can't confirm (and email) twice.
    const updated = await prismock.payment.findUnique({ where: { id: payment.id } });
    expect(updated?.success).toBe(true);
  });
});
