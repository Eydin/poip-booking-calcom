import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { confirmPayment, confirmSetup, push, selectMethod } = vi.hoisted(() => ({
  confirmPayment: vi.fn(),
  confirmSetup: vi.fn(),
  push: vi.fn(),
  selectMethod: { current: (_type: string) => undefined as void },
}));

vi.mock("@calcom/lib/constants", () => ({
  WEBAPP_URL: "https://booking.thepathofinitiationprague.com",
}));
vi.mock("@calcom/lib/hooks/useLocale", () => ({ useLocale: () => ({ t: (key: string) => key }) }));
vi.mock("@calcom/app-store/stripepayment/lib/client/getStripe", () => ({ default: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@calcom/ui/components/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode; type?: "submit" }) => (
    <button type={props.type ?? "submit"}>{children}</button>
  ),
}));
// A stand-in Payment Element whose method selection the test drives via selectMethod.
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: ReactNode }) => <>{children}</>,
  PaymentElement: ({ onChange }: { onChange: (e: { value: { type: string } }) => void }) => {
    selectMethod.current = (type: string) => onChange({ value: { type } });
    return <div data-testid="payment-element" />;
  },
  useStripe: () => ({ confirmPayment, confirmSetup }),
  useElements: () => ({}),
}));

import StripePaymentComponent, { mustLeaveIframeToPay } from "../StripePaymentComponent";

const RETURN_URL = "https://booking.thepathofinitiationprague.com/booking/booking-uid-1";

function renderForm(paymentOption: string | null = "ON_BOOKING") {
  render(
    <StripePaymentComponent
      clientSecret="pi_123_secret"
      publishableKey="pk_test"
      paymentOption={paymentOption}
      bookingUid="booking-uid-1"
    />
  );
}

async function pick(type: string) {
  await act(async () => selectMethod.current(type));
}

async function submit() {
  await act(async () => {
    fireEvent.submit(screen.getByTestId("payment-element").closest("form") as HTMLFormElement);
  });
}

describe("mustLeaveIframeToPay", () => {
  it.each(["card", "link", "apple_pay", "google_pay"])("keeps %s inside the embed", (type) => {
    expect(mustLeaveIframeToPay(type, true)).toBe(false);
  });

  it.each(["klarna", "revolut_pay", "bancontact"])("moves %s to a full page when embedded", (type) => {
    expect(mustLeaveIframeToPay(type, true)).toBe(true);
  });

  it("never leaves when the page isn't embedded, or before a method is picked", () => {
    expect(mustLeaveIframeToPay("klarna", false)).toBe(false);
    expect(mustLeaveIframeToPay(null, true)).toBe(false);
  });
});

describe("Stripe payment form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pays by card and shows the booking as confirmed straight away", async () => {
    confirmPayment.mockResolvedValue({ paymentIntent: { status: "succeeded" } });
    renderForm();
    await pick("card");

    await submit();

    expect(confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ redirect: "if_required", confirmParams: { return_url: RETURN_URL } })
    );
    expect(push).toHaveBeenCalledWith("/booking/booking-uid-1?redirect_status=succeeded");
  });

  it("doesn't claim success while the payment is still processing", async () => {
    confirmPayment.mockResolvedValue({ paymentIntent: { status: "processing" } });
    renderForm();

    await submit();

    expect(push).toHaveBeenCalledWith("/booking/booking-uid-1");
  });

  it("shows Stripe's error and stays on the page when the payment fails", async () => {
    confirmPayment.mockResolvedValue({ error: { message: "Your card was declined." } });
    renderForm();

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Your card was declined.");
    expect(push).not.toHaveBeenCalled();
  });

  it("saves the card for a later no-show fee (HOLD) with a return URL", async () => {
    confirmSetup.mockResolvedValue({ setupIntent: { status: "succeeded" } });
    renderForm("HOLD");

    await submit();

    expect(confirmPayment).not.toHaveBeenCalled();
    expect(confirmSetup).toHaveBeenCalledWith(
      expect.objectContaining({ redirect: "if_required", confirmParams: { return_url: RETURN_URL } })
    );
    expect(push).toHaveBeenCalledWith("/booking/booking-uid-1?redirect_status=succeeded");
  });

  it("lets Stripe handle redirect methods like Klarna when the page isn't embedded", async () => {
    confirmPayment.mockResolvedValue({ paymentIntent: { status: "succeeded" } });
    renderForm();
    await pick("klarna");

    await submit();

    expect(confirmPayment).toHaveBeenCalled();
    expect(screen.queryByTestId("continue-full-page-note")).toBeNull();
  });

  describe("inside the booking embed (iframe)", () => {
    const originalTop = Object.getOwnPropertyDescriptor(window, "top");
    let fakeTop: { location: { href: string } };

    beforeEach(() => {
      fakeTop = { location: { href: "https://www.thepathofinitiationprague.com/sacred-geometry" } };
      Object.defineProperty(window, "top", { value: fakeTop, configurable: true });
    });
    afterEach(() => {
      if (originalTop) Object.defineProperty(window, "top", originalTop);
    });

    it("reopens the payment page full-page instead of redirecting inside the iframe for Klarna", async () => {
      renderForm();
      await pick("klarna");

      expect(screen.getByTestId("continue-full-page-note")).toBeTruthy();
      await submit();

      expect(confirmPayment).not.toHaveBeenCalled();
      expect(fakeTop.location.href).toBe(window.location.href);
    });

    it.each(["card", "apple_pay", "google_pay", "link"])("pays with %s right inside the embed", async (type) => {
      confirmPayment.mockResolvedValue({ paymentIntent: { status: "succeeded" } });
      renderForm();
      await pick(type);

      await submit();

      await waitFor(() => expect(confirmPayment).toHaveBeenCalled());
      expect(fakeTop.location.href).toBe("https://www.thepathofinitiationprague.com/sacred-geometry");
      expect(screen.queryByTestId("continue-full-page-note")).toBeNull();
    });
  });
});
