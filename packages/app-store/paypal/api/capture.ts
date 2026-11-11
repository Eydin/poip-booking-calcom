import type { NextApiRequest, NextApiResponse } from "next";
import z from "zod";

import { findPaymentCredentials } from "@calcom/app-store/paypal/api/webhook";
import { completePaypalOrder } from "@calcom/app-store/paypal/lib/completePaypalOrder";
import prisma from "@calcom/prisma";

const captureRequestSchema = z.object({
  bookingUid: z.string(),
  // PayPal appends the order id as `token` to the order's return_url.
  token: z.string(),
});

/**
 * The order's return_url: PayPal sends the booker here after they approve the payment.
 * Captures the order and confirms the booking (see completePaypalOrder), then shows the
 * booking page - or sends them back to the payment page if the payment didn't go through.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const fallbackBookingUid = typeof req.query.bookingUid === "string" ? req.query.bookingUid : "";
  try {
    if (req.method !== "GET") {
      throw new Error("Invalid method");
    }

    const parseRequest = captureRequestSchema.safeParse(req.query);
    if (!parseRequest.success) {
      throw new Error("Request is malformed");
    }
    const { bookingUid, token } = parseRequest.data;

    const booking = await prisma.booking.findUnique({
      where: { uid: bookingUid },
      select: { id: true },
    });
    if (!booking) {
      throw new Error("Booking not found");
    }

    const credentials = await findPaymentCredentials(booking.id);
    if (!credentials.clientId) {
      throw new Error("Credentials not found");
    }

    const result = await completePaypalOrder({
      orderId: token,
      credentials,
      expectedBookingId: booking.id,
      source: "return",
    });

    if (result.status === "payment_not_found") {
      throw new Error("Payment not found");
    }
    if (result.status === "not_completed") {
      // e.g. PayPal declined the funding source - let them try again.
      return res.redirect(`/payment/${result.paymentUid}?paypalPaymentStatus=failed`);
    }
    return res.redirect(`/booking/${bookingUid}?paypalPaymentStatus=success`);
  } catch (err) {
    console.error("PayPal capture failed", err);
    return res.redirect(`/booking/${encodeURIComponent(fallbackBookingUid)}?paypalPaymentStatus=failed`);
  }
}
