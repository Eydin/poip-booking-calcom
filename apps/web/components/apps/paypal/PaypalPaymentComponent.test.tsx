import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PaypalPaymentComponent } from "./PaypalPaymentComponent";

const orderWithLink = (rel: string) => ({
  order: {
    id: "ORDER_1",
    status: "PAYER_ACTION_REQUIRED",
    links: [
      { href: "https://api.paypal.com/v2/checkout/orders/ORDER_1", rel: "self", method: "GET" },
      { href: "https://www.paypal.com/checkoutnow?token=ORDER_1", rel, method: "GET" },
    ],
  },
});

describe("PaypalPaymentComponent", () => {
  it.each(["payer-action", "approve"])(
    "links to PayPal's %s URL and opens it outside the booking embed's iframe",
    (rel) => {
      render(<PaypalPaymentComponent payment={{ data: orderWithLink(rel) }} />);

      const button = screen.getByTestId("paypal-pay-button");
      expect(button.getAttribute("href")).toBe("https://www.paypal.com/checkoutnow?token=ORDER_1");
      // PayPal's checkout refuses to render in an iframe; _top leaves the embed.
      expect(button.getAttribute("target")).toBe("_top");
    }
  );

  it("shows an error instead of a button when the order has no approval link", () => {
    render(
      <PaypalPaymentComponent
        payment={{ data: { order: { id: "ORDER_1", status: "CREATED", links: [] } } }}
      />
    );

    expect(screen.queryByTestId("paypal-pay-button")).toBeNull();
    expect(screen.getByText("Couldn't obtain payment URL")).toBeTruthy();
  });

  it("shows an error for payment data that isn't a PayPal order", () => {
    render(<PaypalPaymentComponent payment={{ data: { client_secret: "pi_123_secret" } }} />);

    expect(screen.queryByTestId("paypal-pay-button")).toBeNull();
  });
});
