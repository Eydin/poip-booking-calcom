import type { PaymentAppData } from "@calcom/app-store/_utils/payments/getPaymentAppData";
import { HttpError } from "@calcom/lib/http-error";
import type { PrismaClient } from "@calcom/prisma";

import { getChosenPaymentMethod } from "./bankTransfer";

export const PAYPAL_PAYMENT_METHOD_VALUE = "paypal";
const PAYPAL_APP_ID = "paypal";

/**
 * PayPal is offered as an alternative to the event type's configured payment app (Stripe):
 * the booker picks it in the same "paymentMethod" booking field that offers bank transfer.
 */
export function isPaypalChosen(responses: unknown): boolean {
  return getChosenPaymentMethod(responses) === PAYPAL_PAYMENT_METHOD_VALUE;
}

/**
 * handlePayment reads price/currency/paymentOption from metadata.apps[<credential appId>],
 * and event types only carry Stripe's app data. Copy the configured app's own price and
 * currency - the exact values handlePayment would charge through Stripe - into a `paypal`
 * entry (booking-field add-ons are still added on top by handlePayment itself). getPaymentAppData's
 * values are only a fallback: they prefer the event type's own price/currency columns, which
 * can differ from what Stripe charges. PayPal requires upper-case ISO currency codes.
 */
export function withPaypalAppData(
  metadata: { apps?: unknown } | null | undefined,
  paymentAppData: Pick<PaymentAppData, "appId" | "price" | "currency">
) {
  const apps =
    metadata?.apps && typeof metadata.apps === "object" ? (metadata.apps as Record<string, unknown>) : {};
  const configured = (paymentAppData.appId ? apps[paymentAppData.appId] : undefined) as
    | { price?: number; currency?: string }
    | undefined;
  return {
    ...(metadata ?? {}),
    apps: {
      ...apps,
      [PAYPAL_APP_ID]: {
        enabled: true,
        price: configured?.price ?? paymentAppData.price,
        currency: (configured?.currency || paymentAppData.currency).toUpperCase(),
        paymentOption: "ON_BOOKING",
      },
    },
  };
}

/**
 * Resolves the organizer's PayPal credential and the event-type metadata to pass to
 * handlePayment when the booker chose PayPal. Throws a 400 when PayPal can't be used.
 */
export async function getPaypalPaymentOverride({
  prismaClient,
  organizerUserId,
  paymentAppData,
  metadata,
}: {
  prismaClient: Pick<PrismaClient, "credential">;
  organizerUserId: number;
  paymentAppData: Pick<PaymentAppData, "appId" | "price" | "currency" | "paymentOption">;
  metadata: { apps?: unknown } | null | undefined;
}) {
  // PayPal can only take the payment now; it can't save a card for a later no-show fee.
  if (paymentAppData.paymentOption !== "ON_BOOKING") {
    throw new HttpError({ statusCode: 400, message: "PayPal is not available for this event" });
  }

  const credential = await prismaClient.credential.findFirst({
    where: { appId: PAYPAL_APP_ID, userId: organizerUserId },
    select: {
      key: true,
      appId: true,
      app: { select: { categories: true, dirName: true } },
    },
  });

  if (!credential) {
    throw new HttpError({ statusCode: 400, message: "PayPal payment is not configured" });
  }

  return { credential, metadata: withPaypalAppData(metadata, paymentAppData) };
}
