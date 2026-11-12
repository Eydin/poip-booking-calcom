import { v4 as uuidv4 } from "uuid";
import z from "zod";

import Paypal from "@calcom/app-store/paypal/lib/Paypal";
import dayjs from "@calcom/dayjs";
import tasker from "@calcom/features/tasker";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { ErrorCode } from "@calcom/lib/errorCodes";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import prisma from "@calcom/prisma";
import type { Booking, Payment, PaymentOption, Prisma } from "@calcom/prisma/client";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { IAbstractPaymentService } from "@calcom/types/PaymentService";

import { paymentOptionEnum } from "../zod";

const log = logger.getSubLogger({ prefix: ["payment-service:paypal"] });

export const paypalCredentialKeysSchema = z.object({
  client_id: z.string(),
  secret_key: z.string(),
  webhook_id: z.string(),
});

class PaypalPaymentService implements IAbstractPaymentService {
  private credentials: z.infer<typeof paypalCredentialKeysSchema> | null;

  constructor(credentials: { key: Prisma.JsonValue }) {
    const keyParsing = paypalCredentialKeysSchema.safeParse(credentials.key);
    if (keyParsing.success) {
      this.credentials = keyParsing.data;
    } else {
      this.credentials = null;
    }
  }

  async create(
    payment: Pick<Prisma.PaymentUncheckedCreateInput, "amount" | "currency">,
    bookingId: Booking["id"]
  ) {
    try {
      const booking = await prisma.booking.findUnique({
        select: {
          uid: true,
          title: true,
        },
        where: {
          id: bookingId,
        },
      });
      if (!booking || !this.credentials) {
        throw new Error();
      }

      const uid = uuidv4();

      const paypalClient = new Paypal({
        clientId: this.credentials.client_id,
        secretKey: this.credentials.secret_key,
      });
      const orderResult = await paypalClient.createOrder({
        referenceId: uid,
        amount: payment.amount,
        currency: payment.currency,
        returnUrl: `${WEBAPP_URL}/api/integrations/paypal/capture?bookingUid=${booking.uid}`,
        cancelUrl: `${WEBAPP_URL}/payment/${uid}`,
        description: booking.title,
      });
      if (!orderResult?.id) {
        throw new Error("Paypal: order could not be created");
      }
      const paymentData = await prisma.payment.create({
        data: {
          uid,
          app: {
            connect: {
              slug: "paypal",
            },
          },
          booking: {
            connect: {
              id: bookingId,
            },
          },
          amount: payment.amount,
          externalId: orderResult.id,
          currency: payment.currency,
          data: Object.assign({}, { order: orderResult }) as unknown as Prisma.InputJsonValue,
          fee: 0,
          refunded: false,
          success: false,
        },
      });

      if (!paymentData) {
        throw new Error();
      }
      return paymentData;
    } catch (error) {
      log.error("Paypal: Payment could not be created for bookingId", bookingId, safeStringify(error));
      throw new Error(ErrorCode.PaymentCreationFailure);
    }
  }
  async update(): Promise<Payment> {
    throw new Error("Method not implemented.");
  }
  /** Fully refunds a captured PayPal payment (called when a paid booking is cancelled). */
  async refund(paymentId: Payment["id"]): Promise<Payment | null> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
      return null;
    }
    if (!payment.success) {
      throw new Error("Unable to refund failed payment");
    }
    if (payment.refunded) {
      // refunded already, bail early as success without throwing an error.
      return payment;
    }
    if (!this.credentials || !payment.externalId) {
      throw new Error("Paypal: credentials or order id missing, can't refund");
    }

    const paypalClient = new Paypal({
      clientId: this.credentials.client_id,
      secretKey: this.credentials.secret_key,
    });

    // completePaypalOrder stores the capture id; fall back to reading it off the order.
    const data = payment.data as Record<string, unknown> | null;
    let captureId = typeof data?.captureId === "string" ? data.captureId : null;
    if (!captureId) {
      const order = await paypalClient.getOrder(payment.externalId);
      captureId = order?.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null;
    }
    if (!captureId) {
      throw new Error(`Paypal: no capture found for order ${payment.externalId}, can't refund`);
    }

    const refund = await paypalClient.refundCapture(captureId);
    if (!refund.ok) {
      throw new Error(`PayPal refund failed for transaction ${captureId}: ${refund.reason}`);
    }

    return prisma.payment.update({
      where: { id: payment.id },
      data: { refunded: true },
    });
  }

  async collectCard(
    payment: Pick<Prisma.PaymentUncheckedCreateInput, "amount" | "currency">,
    bookingId: number,
    paymentOption: PaymentOption,
    _bookerEmail?: string | null
  ): Promise<Payment> {
    // Ensure that the payment service can support the passed payment option
    if (paymentOptionEnum.parse(paymentOption) !== "HOLD") {
      throw new Error("Payment option is not compatible with create method");
    }
    try {
      const booking = await prisma.booking.findUnique({
        select: {
          uid: true,
          title: true,
        },
        where: {
          id: bookingId,
        },
      });
      if (!booking || !this.credentials) {
        throw new Error();
      }

      const uid = uuidv4();

      const paypalClient = new Paypal({
        clientId: this.credentials.client_id,
        secretKey: this.credentials.secret_key,
      });
      const preference = await paypalClient.createOrder({
        referenceId: uid,
        amount: payment.amount,
        currency: payment.currency,
        returnUrl: `${WEBAPP_URL}/booking/${booking.uid}`,
        cancelUrl: `${WEBAPP_URL}/payment/${uid}`,
        intent: "AUTHORIZE",
      });

      const paymentData = await prisma.payment.create({
        data: {
          uid,
          app: {
            connect: {
              slug: "paypal",
            },
          },
          booking: {
            connect: {
              id: bookingId,
            },
          },
          amount: payment.amount,
          currency: payment.currency,
          data: Object.assign({}, preference) as unknown as Prisma.InputJsonValue,
          fee: 0,
          refunded: false,
          success: false,
          paymentOption: paymentOption || "ON_BOOKING",
          externalId: preference?.id,
        },
      });

      if (!paymentData) {
        throw new Error();
      }
      return paymentData;
    } catch (error) {
      log.error(
        "Paypal: Payment method could not be collected for bookingId",
        bookingId,
        safeStringify(error)
      );
      throw new Error("Paypal: Payment method could not be collected");
    }
  }
  chargeCard(): Promise<Payment> {
    throw new Error("Method not implemented.");
  }
  getPaymentPaidStatus(): Promise<string> {
    throw new Error("Method not implemented.");
  }
  getPaymentDetails(): Promise<Payment> {
    throw new Error("Method not implemented.");
  }
  /**
   * Same as Stripe: if the booker hasn't paid a few minutes after booking (e.g. they closed
   * PayPal), email them a link back to the payment page. handlePaymentSuccess cancels the email
   * once the payment completes.
   */
  async afterPayment(
    event: CalendarEvent,
    booking: { id: number; uid: string },
    paymentData: Payment
  ): Promise<void> {
    const delayMinutes = Number(process.env.AWAITING_PAYMENT_EMAIL_DELAY_MINUTES) || 15;
    await tasker.create(
      "sendAwaitingPaymentEmail",
      {
        bookingId: booking.id,
        paymentId: paymentData.id,
        attendeeSeatId: event.attendeeSeatId || null,
      },
      {
        scheduledAt: dayjs().add(delayMinutes, "minutes").toDate(),
        referenceUid: booking.uid,
      }
    );
  }
  deletePayment(): Promise<boolean> {
    return Promise.resolve(false);
  }

  isSetupAlready(): boolean {
    return !!this.credentials;
  }
}

/**
 * Factory function that creates a PayPal Payment service instance.
 * This is exported instead of the class to prevent internal types
 * from leaking into the emitted .d.ts file.
 */
export function BuildPaymentService(credentials: { key: Prisma.JsonValue }): IAbstractPaymentService {
  return new PaypalPaymentService(credentials);
}
