import { z } from "zod";

// PaymentService.create() (ON_BOOKING) stores the Stripe PaymentIntent object
// spread directly onto Payment.data, so the client secret is at the top level.
const onBookingDataSchema = z.object({
  client_secret: z.string(),
});

// PaymentService.collectCard() (HOLD) stores the Stripe SetupIntent nested
// under a `setupIntent` key instead, alongside other metadata.
const holdDataSchema = z.object({
  setupIntent: z.object({
    client_secret: z.string(),
  }),
});

/**
 * Payment.data is an untyped Json column whose shape differs by paymentOption
 * (see PaymentService.create vs PaymentService.collectCard). This pulls the
 * Stripe client secret out of whichever shape applies, or returns null if the
 * payment isn't a Stripe payment / doesn't have one yet.
 */
export function getClientSecretFromPaymentData(
  paymentOption: string | null,
  data: unknown
): string | null {
  if (paymentOption === "HOLD") {
    const parsed = holdDataSchema.safeParse(data);
    return parsed.success ? parsed.data.setupIntent.client_secret : null;
  }

  const parsed = onBookingDataSchema.safeParse(data);
  return parsed.success ? parsed.data.client_secret : null;
}
