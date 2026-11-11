import { describe, expect, it } from "vitest";

import type { Fields } from "@calcom/features/bookings/lib/getBookingFields";

import { calculatePaymentAmount, getBookerCharge, getEventTypePaymentAppPricing } from "./calculatePaymentAmount";

// Empower Thyself: a 12,000 CZK deposit by default, or +24,500 CZK to pay the full 36,500 now.
const paymentChoiceField = {
  name: "paymentChoice",
  type: "select",
  label: "Pay in full or just the deposit?",
  required: true,
  options: [
    { label: "Deposit - 12,000 CZK now", value: "deposit", price: 0 },
    { label: "Pay in full - 36,500 CZK now", value: "full", price: 24500 },
  ],
} as unknown as Fields[number];

const stripe = { price: 1200000, currency: "czk", enabled: true };

const responses = (paymentChoice?: string) =>
  paymentChoice ? { paymentChoice: { label: "Pay in full or just the deposit?", value: paymentChoice } } : {};

describe("calculatePaymentAmount", () => {
  it("charges the base price when no priced option is picked", () => {
    expect(
      calculatePaymentAmount({ appData: stripe, bookingFields: [paymentChoiceField], responses: responses("deposit") })
    ).toEqual({ amount: 1200000, currency: "czk" });
  });

  it("adds the price of the picked select option (Pay in full)", () => {
    expect(
      calculatePaymentAmount({ appData: stripe, bookingFields: [paymentChoiceField], responses: responses("full") })
    ).toEqual({ amount: 3650000, currency: "czk" });
  });

  it("ignores fields the booker didn't answer and fields without pricing", () => {
    const textField = { name: "notes", type: "textarea", label: "Notes" } as unknown as Fields[number];
    expect(
      calculatePaymentAmount({
        appData: stripe,
        bookingFields: [paymentChoiceField, textField],
        responses: { notes: { label: "Notes", value: "full" } },
      })
    ).toEqual({ amount: 1200000, currency: "czk" });
  });

  it("adds every picked checkbox / multiselect option", () => {
    const extras = {
      name: "extras",
      type: "multiselect",
      label: "Extras",
      options: [
        { label: "Book", value: "book", price: 500 },
        { label: "Crystal", value: "crystal", price: 300 },
        { label: "Nothing", value: "none" },
      ],
    } as unknown as Fields[number];

    expect(
      calculatePaymentAmount({
        appData: stripe,
        bookingFields: [extras],
        responses: { extras: { label: "Extras", value: ["book", "crystal", "none"] } },
      })
    ).toEqual({ amount: 1200000 + 80000, currency: "czk" });
  });

  it("multiplies a priced number field and adds a priced boolean", () => {
    const people = { name: "people", type: "number", label: "People", price: 1000 } as unknown as Fields[number];
    const parking = { name: "parking", type: "boolean", label: "Parking", price: 150 } as unknown as Fields[number];

    expect(
      calculatePaymentAmount({
        appData: stripe,
        bookingFields: [people, parking],
        responses: { people: { label: "People", value: "2" }, parking: { label: "Parking", value: true } },
      })
    ).toEqual({ amount: 1200000 + 215000, currency: "czk" });
  });

  it("falls back to 0 USD without app data (Cal.com's previous behaviour)", () => {
    expect(calculatePaymentAmount({ appData: undefined, responses: {} })).toEqual({ amount: 0, currency: "USD" });
  });
});

describe("getEventTypePaymentAppPricing", () => {
  it("reads the app's entry from event type metadata", () => {
    expect(getEventTypePaymentAppPricing({ apps: { stripe } }, "stripe")).toMatchObject(stripe);
    expect(getEventTypePaymentAppPricing({ apps: { stripe } }, "paypal")).toBeUndefined();
    expect(getEventTypePaymentAppPricing({ apps: { stripe } }, null)).toBeUndefined();
    expect(getEventTypePaymentAppPricing(null, "stripe")).toBeUndefined();
  });
});

describe("getBookerCharge", () => {
  it("charges what the event type's payment app would, including priced options", () => {
    expect(
      getBookerCharge({
        eventTypeMetadata: { apps: { stripe } },
        // getPaymentAppData prefers the event type's own columns, which may say something else.
        paymentAppData: { appId: "stripe", price: 1, currency: "usd" },
        bookingFields: [paymentChoiceField],
        responses: responses("full"),
      })
    ).toEqual({ amount: 3650000, currency: "czk" });
  });

  it("falls back to getPaymentAppData's price when the app has no metadata entry", () => {
    expect(
      getBookerCharge({
        eventTypeMetadata: {},
        paymentAppData: { appId: "stripe", price: 420000, currency: "czk" },
        responses: {},
      })
    ).toEqual({ amount: 420000, currency: "czk" });
  });
});
