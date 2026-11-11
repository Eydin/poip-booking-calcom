import prismock from "@calcom/testing/lib/__mocks__/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { findPaymentCredentials } from "@calcom/app-store/paypal/api/webhook";
import { completePaypalOrder } from "@calcom/app-store/paypal/lib/completePaypalOrder";

import handler from "./capture";

vi.mock("@calcom/app-store/paypal/api/webhook", () => ({ findPaymentCredentials: vi.fn() }));
vi.mock("@calcom/app-store/paypal/lib/completePaypalOrder", () => ({ completePaypalOrder: vi.fn() }));

const mockedFindPaymentCredentials = vi.mocked(findPaymentCredentials);
const mockedCompletePaypalOrder = vi.mocked(completePaypalOrder);

const credentials = { clientId: "client", secretKey: "secret", webhookId: "wh" };

function callHandler(query: Record<string, string>, method = "GET") {
  const res = { redirect: vi.fn() };
  return handler({ method, query } as unknown as NextApiRequest, res as unknown as NextApiResponse).then(
    () => res.redirect
  );
}

describe("PayPal return handler (api/integrations/paypal/capture)", () => {
  let bookingId: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    await prismock.booking.deleteMany();
    const booking = await prismock.booking.create({
      data: {
        uid: "booking-uid-1",
        title: "Sacred Geometry 1 Class",
        startTime: new Date("2026-12-01T10:00:00Z"),
        endTime: new Date("2026-12-01T14:30:00Z"),
      },
    });
    bookingId = booking.id;
    mockedFindPaymentCredentials.mockResolvedValue(credentials);
    mockedCompletePaypalOrder.mockResolvedValue({ status: "paid", paymentUid: "payment-uid-1" });
  });

  it("completes the order for this booking and shows the booking page", async () => {
    const redirect = await callHandler({ bookingUid: "booking-uid-1", token: "ORDER_1" });

    expect(mockedCompletePaypalOrder).toHaveBeenCalledWith({
      orderId: "ORDER_1",
      credentials,
      expectedBookingId: bookingId,
      source: "return",
    });
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/booking/booking-uid-1?paypalPaymentStatus=success");
  });

  it("also shows the booking page when the webhook already completed the order", async () => {
    mockedCompletePaypalOrder.mockResolvedValue({ status: "already_paid", paymentUid: "payment-uid-1" });

    const redirect = await callHandler({ bookingUid: "booking-uid-1", token: "ORDER_1" });

    expect(redirect).toHaveBeenCalledWith("/booking/booking-uid-1?paypalPaymentStatus=success");
  });

  it("sends the booker back to the payment page when the payment didn't go through", async () => {
    mockedCompletePaypalOrder.mockResolvedValue({ status: "not_completed", paymentUid: "payment-uid-1" });

    const redirect = await callHandler({ bookingUid: "booking-uid-1", token: "ORDER_1" });

    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/payment/payment-uid-1?paypalPaymentStatus=failed");
  });

  it.each([
    ["the order isn't this booking's", () => mockedCompletePaypalOrder.mockResolvedValue({ status: "payment_not_found" })],
    ["confirming the booking throws", () => mockedCompletePaypalOrder.mockRejectedValue(new Error("boom"))],
    ["PayPal isn't connected", () => mockedFindPaymentCredentials.mockResolvedValue({ clientId: "", secretKey: "", webhookId: "" })],
  ])("redirects exactly once with a failed status when %s", async (_case, arrange) => {
    arrange();

    const redirect = await callHandler({ bookingUid: "booking-uid-1", token: "ORDER_1" });

    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/booking/booking-uid-1?paypalPaymentStatus=failed");
  });

  it("fails for an unknown booking without touching PayPal", async () => {
    const redirect = await callHandler({ bookingUid: "nope", token: "ORDER_1" });

    expect(mockedCompletePaypalOrder).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/booking/nope?paypalPaymentStatus=failed");
  });

  it("rejects requests missing the PayPal token or using the wrong method", async () => {
    await callHandler({ bookingUid: "booking-uid-1" });
    await callHandler({ bookingUid: "booking-uid-1", token: "ORDER_1" }, "POST");

    expect(mockedCompletePaypalOrder).not.toHaveBeenCalled();
  });
});
