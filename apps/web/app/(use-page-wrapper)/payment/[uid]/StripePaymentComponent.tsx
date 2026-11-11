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

/**
 * Payment methods that complete inside this page: card 3-D Secure, Link and the wallets open
 * their own modal/sheet. Every other method (e.g. Klarna) sends the booker to its provider's site.
 */
const METHODS_PAYABLE_INSIDE_AN_IFRAME = new Set(["card", "link", "apple_pay", "google_pay"]);

/**
 * This page is often shown inside the booking embed (an iframe) on the main site. Providers'
 * checkout sites generally refuse to load inside an iframe, so a booker who picks a
 * redirect-based method there is first taken to this same payment page as a full page.
 * Exported for testing.
 */
export function mustLeaveIframeToPay(paymentMethodType: string | null, isInIframe: boolean): boolean {
  return isInIframe && !!paymentMethodType && !METHODS_PAYABLE_INSIDE_AN_IFRAME.has(paymentMethodType);
}

function isInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // Accessing window.top can throw in sandboxed iframes - which are iframes.
    return true;
  }
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
  const [selectedMethod, setSelectedMethod] = useState<string | null>(null);
  const leavesIframe = mustLeaveIframeToPay(selectedMethod, isInIframe());

  const handleSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!stripe || !elements) return;

    if (leavesIframe && window.top) {
      // Allowed from a cross-origin iframe because it follows this click (user activation);
      // Location's href setter is one of the few things a cross-origin frame may use.
      window.top.location.href = window.location.href;
      return;
    }

    setState({ status: "processing" });

    const result =
      paymentOption === "HOLD"
        ? await stripe.confirmSetup({
            elements,
            redirect: "if_required",
            // Only used if the card's bank forces a full-page redirect; required by Stripe then.
            confirmParams: { return_url: buildConfirmReturnUrl(bookingUid) },
          })
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
    // server, which can lag slightly behind this client-side confirmation.
    // When Stripe already told us the intent succeeded, say so via
    // redirect_status so the booking success page shows "confirmed" right
    // away instead of waiting on the webhook; it also auto-refreshes itself
    // as a fallback in the meantime.
    const intent = "setupIntent" in result ? result.setupIntent : result.paymentIntent;
    const query = intent?.status === "succeeded" ? "?redirect_status=succeeded" : "";
    router.push(`/booking/${bookingUid}${query}`);
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4">
      <PaymentElement
        onChange={(event) => {
          setState({ status: "idle" });
          setSelectedMethod(event.value.type);
        }}
      />
      {leavesIframe && (
        <p className="text-subtle mt-2 text-sm" data-testid="continue-full-page-note">
          This payment method continues on a full page - choose it again there to pay.
        </p>
      )}
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
