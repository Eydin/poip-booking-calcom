import type { NextApiRequest, NextApiResponse } from "next";
import getRawBody from "raw-body";
import Stripe from "stripe";

import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import { getStripeAppKeys } from "@calcom/app-store/stripepayment/lib/getStripeAppKeys";
import { IS_PRODUCTION } from "@calcom/lib/constants";
import { HttpError as HttpCode } from "@calcom/lib/http-error";
import { getServerErrorFromUnknown } from "@calcom/lib/server/getServerErrorFromUnknown";
import { distributedTracing } from "@calcom/lib/tracing/factory";
import prisma from "@calcom/prisma";

export const config = {
  api: {
    bodyParser: false,
  },
};

// Event types whose object id corresponds to Payment.externalId and whose
// arrival means the booker has successfully paid (ON_BOOKING) or successfully
// attached a card to be charged later (HOLD, e.g. a no-show fee).
const HANDLED_EVENT_TYPES = new Set(["payment_intent.succeeded", "setup_intent.succeeded"]);

export async function getPaymentForStripeEvent(event: Stripe.Event) {
  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    return null;
  }

  const object = event.data.object as Stripe.PaymentIntent | Stripe.SetupIntent;

  return prisma.payment.findUnique({
    where: { externalId: object.id },
    select: { id: true, bookingId: true },
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") {
      throw new HttpCode({ statusCode: 405, message: "Method Not Allowed" });
    }

    const sig = req.headers["stripe-signature"];
    if (!sig || Array.isArray(sig)) {
      throw new HttpCode({ statusCode: 400, message: "Missing stripe-signature header" });
    }

    const { webhook_secret } = await getStripeAppKeys();
    const bodyRaw = await getRawBody(req);

    // constructEvent only does local HMAC verification; it needs a Stripe
    // instance but not a valid/authenticated API key to do so.
    const stripe = new Stripe("", { apiVersion: "2020-08-27" });

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(bodyRaw, sig, webhook_secret);
    } catch (err) {
      console.error("Stripe webhook signature verification failed", err);
      throw new HttpCode({ statusCode: 400, message: "Invalid signature" });
    }

    const payment = await getPaymentForStripeEvent(event);
    if (!payment) {
      // Either an event type we don't act on, or no matching Payment row
      // (e.g. a test event, or a PaymentIntent from a different app) - not an error.
      return res.status(204).end();
    }

    const traceContext = distributedTracing.createTrace("stripe_webhook", {
      meta: { paymentId: payment.id, bookingId: payment.bookingId },
    });

    return await handlePaymentSuccess({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      appSlug: "stripe",
      traceContext,
    });
  } catch (_err) {
    const err = getServerErrorFromUnknown(_err);
    if (!(err.statusCode >= 400 && err.statusCode < 500)) {
      console.error(`Stripe webhook error: ${err.message}`);
    }
    return res.status(err.statusCode).send({
      message: err.message,
      stack: IS_PRODUCTION ? undefined : err.cause?.stack,
    });
  }
}
