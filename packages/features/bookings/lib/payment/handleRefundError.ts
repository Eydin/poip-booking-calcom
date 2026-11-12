import { sendOrganizerPaymentRefundFailedEmail } from "@calcom/emails/billing-email-service";
import type { Payment } from "@calcom/prisma/client";
import type { EventTypeMetadata } from "@calcom/prisma/zod-utils";
import type { CalendarEvent } from "@calcom/types/Calendar";

/**
 * Emails the organizer (and any extra organizer recipients) that an automatic refund failed, so
 * they can refund the booker by hand. Never throws: the booking change that triggered the refund
 * (cancel / reject) has already happened and must not be undone by a failed email.
 */
const handleRefundError = async (opts: {
  event: CalendarEvent;
  reason: string;
  paymentId: string;
  eventTypeMetadata?: EventTypeMetadata;
}) => {
  console.error(`refund failed: ${opts.reason} for booking '${opts.event.uid}'`);
  try {
    await sendOrganizerPaymentRefundFailedEmail(
      {
        ...opts.event,
        paymentInfo: { reason: opts.reason, id: opts.paymentId },
      },
      opts.eventTypeMetadata
    );
  } catch (e) {
    console.error(e);
  }
};

/** The payment(s) a refund was attempted for, as the provider's own ids where we have them. */
const describeRefundedPayments = (payments: Pick<Payment, "uid" | "externalId" | "success" | "refunded">[]) =>
  payments
    .filter((payment) => payment.success && !payment.refunded)
    .map((payment) => payment.externalId || payment.uid)
    .join(", ");

export { describeRefundedPayments, handleRefundError };
