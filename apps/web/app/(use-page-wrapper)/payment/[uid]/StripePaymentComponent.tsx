"use client";

import getStripe from "@calcom/app-store/stripepayment/lib/client/getStripe";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState } from "react";

export type StripePaymentComponentProps = {
  clientSecret: string;
  publishableKey: string;
  paymentOption: string | null;
  bookingUid: string;
};

/**
 * Where Stripe redirects the booker back to after completing (or needing to
 * complete, e.g. 3D Secure) the payment off-site. Exported for testing.
 */
export function buildConfirmReturnUrl(bookingUid: string) {
  return `${WEBAPP_URL}/booking/${bookingUid}`;
}

type SubmitState = { status: "idle" } | { status: "processing" } | { status: "error"; message: string };

function StripePaymentFormInner({
  paymentOption,
  bookingUid,
}: Pick<StripePaymentComponentProps, "paymentOption" | "bookingUid">) {
  const { t } = useLocale();
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [state, setState] = useState<SubmitState>({ status: "idle" });

  const handleSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!stripe || !elements) return;

    setState({ status: "processing" });

    const result =
      paymentOption === "HOLD"
        ? await stripe.confirmSetup({ elements, redirect: "if_required" })
        : await stripe.confirmPayment({
            elements,
            redirect: "if_required",
            confirmParams: { return_url: buildConfirmReturnUrl(bookingUid) },
          });

    if (result.error) {
      setState({ status: "error", message: result.error.message ?? t("could_not_charge_card") });
      return;
    }

    setState({ status: "idle" });
    // The booking confirms asynchronously once Stripe's webhook reaches the
    // server; the booking success page already handles a booking that is
    // still momentarily pending.
    router.push(`/booking/${bookingUid}`);
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4">
      <PaymentElement onChange={() => setState({ status: "idle" })} />
      {state.status === "error" && (
        <p className="text-error mt-2 text-sm" role="alert">
          {state.message}
        </p>
      )}
      <Button
        type="submit"
        className="mt-4 w-full justify-center"
        disabled={!stripe || state.status === "processing"}
        loading={state.status === "processing"}>
        {paymentOption === "HOLD" ? t("submit_card") : t("pay_now")}
      </Button>
    </form>
  );
}

export default function StripePaymentComponent({
  clientSecret,
  publishableKey,
  paymentOption,
  bookingUid,
}: StripePaymentComponentProps) {
  const stripePromise = getStripe(publishableKey);

  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: "stripe" } }}>
      <StripePaymentFormInner paymentOption={paymentOption} bookingUid={bookingUid} />
    </Elements>
  );
}
