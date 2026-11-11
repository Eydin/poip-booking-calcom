import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import { HttpError } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import { distributedTracing } from "@calcom/lib/tracing/factory";
import prisma from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";

import Paypal from "./Paypal";

const log = logger.getSubLogger({ prefix: ["paypal:completePaypalOrder"] });

export type CompletePaypalOrderResult =
  | { status: "paid" | "already_paid"; paymentUid: string }
  | { status: "not_completed"; paymentUid: string }
  | { status: "payment_not_found" };

/**
 * Captures a PayPal order the booker approved and confirms its booking. Both the booker's
 * return from PayPal (api/capture) and the CHECKOUT.ORDER.APPROVED webhook call this - the
 * webhook covers bookers who close the tab after approving - so it must only confirm once:
 * the Payment row is claimed with a conditional update (success: false -> true) before
 * handlePaymentSuccess runs, and only the caller that wins the claim sends the confirmation
 * emails and creates the calendar events.
 */
export async function completePaypalOrder({
  orderId,
  credentials,
  expectedBookingId,
  source,
}: {
  orderId: string;
  credentials: { clientId: string; secretKey: string };
  /** When set, the order must belong to this booking. */
  expectedBookingId?: number;
  source: "return" | "webhook";
}): Promise<CompletePaypalOrderResult> {
  const payment = await prisma.payment.findFirst({
    where: { externalId: orderId, appId: "paypal" },
    select: { id: true, uid: true, bookingId: true, success: true, data: true },
  });
  if (!payment) return { status: "payment_not_found" };
  if (expectedBookingId !== undefined && payment.bookingId !== expectedBookingId) {
    return { status: "payment_not_found" };
  }
  if (payment.success) return { status: "already_paid", paymentUid: payment.uid };

  const paypal = new Paypal(credentials);
  const capture = await paypal.captureOrder(orderId);
  if (!capture) return { status: "not_completed", paymentUid: payment.uid };

  const claimed = await prisma.payment.updateMany({
    where: { id: payment.id, success: false },
    data: {
      success: true,
      data: {
        ...((payment.data as Record<string, unknown> | null) ?? {}),
        // Needed to refund the payment later.
        captureId: capture.captureId,
      } as Prisma.InputJsonValue,
    },
  });
  if (claimed.count === 0) return { status: "already_paid", paymentUid: payment.uid };

  const traceContext = distributedTracing.createTrace(`paypal_${source}`, {
    meta: { paymentId: payment.id, bookingId: payment.bookingId },
  });
  try {
    await handlePaymentSuccess({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      appSlug: "paypal",
      traceContext,
    });
  } catch (error) {
    // handlePaymentSuccess reports success by throwing an HttpError with status 200.
    if (error instanceof HttpError && error.statusCode === 200) {
      return { status: "paid", paymentUid: payment.uid };
    }
    // The money has been captured at this point, so don't release the claim and risk
    // confirming twice - log loudly so the booking can be confirmed by hand.
    log.error(
      `PayPal order ${orderId} was captured but confirming booking ${payment.bookingId} failed`,
      safeStringify(error)
    );
    throw error;
  }
  return { status: "paid", paymentUid: payment.uid };
}
