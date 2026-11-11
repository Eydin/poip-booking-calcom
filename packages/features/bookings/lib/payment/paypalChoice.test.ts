import { describe, expect, it, vi } from "vitest";

import { HttpError } from "@calcom/lib/http-error";

import { isBankTransferChosen } from "./bankTransfer";
import {
  getPaypalPaymentOverride,
  isPaypalChosen,
  PAYPAL_PAYMENT_METHOD_VALUE,
  withPaypalAppData,
} from "./paypalChoice";

const stripeAppData = {
  appId: "stripe" as const,
  price: 420000,
  currency: "czk",
  paymentOption: "ON_BOOKING" as const,
};

const paypalCredential = {
  key: { client_id: "id", secret_key: "secret", webhook_id: "wh" },
  appId: "paypal",
  app: { categories: ["payment"], dirName: "paypal" },
};

function prismaWith(credential: unknown) {
  const findFirst = vi.fn().mockResolvedValue(credential);
  return { prismaClient: { credential: { findFirst } } as never, findFirst };
}

describe("isPaypalChosen", () => {
  it("is true only when the paymentMethod response is paypal", () => {
    expect(isPaypalChosen({ paymentMethod: { label: "PayPal", value: PAYPAL_PAYMENT_METHOD_VALUE } })).toBe(
      true
    );
    expect(isPaypalChosen({ paymentMethod: { label: "Card", value: "stripe" } })).toBe(false);
    expect(isPaypalChosen({ paymentMethod: { label: "Bank", value: "bank_transfer" } })).toBe(false);
    expect(isPaypalChosen({ name: { label: "Name", value: "paypal" } })).toBe(false);
    expect(isPaypalChosen({})).toBe(false);
    expect(isPaypalChosen(null)).toBe(false);
    expect(isPaypalChosen(undefined)).toBe(false);
  });

  it("also understands raw form responses (used when joining a seated booking)", () => {
    expect(isPaypalChosen({ paymentMethod: "paypal" })).toBe(true);
    expect(isPaypalChosen({ paymentMethod: "stripe" })).toBe(false);
    expect(isPaypalChosen({ paymentMethod: 42 })).toBe(false);
    expect(isPaypalChosen({ paymentMethod: { value: 42 } })).toBe(false);
  });
});

describe("isBankTransferChosen", () => {
  it("understands both labelled and raw responses", () => {
    expect(isBankTransferChosen({ paymentMethod: { label: "Bank", value: "bank_transfer" } })).toBe(true);
    expect(isBankTransferChosen({ paymentMethod: "bank_transfer" })).toBe(true);
    expect(isBankTransferChosen({ paymentMethod: "paypal" })).toBe(false);
    expect(isBankTransferChosen(null)).toBe(false);
  });
});

describe("withPaypalAppData", () => {
  it("mirrors the configured payment app's price into a paypal entry with an upper-case currency", () => {
    const metadata = {
      organizerCcEmails: ["diana@example.com"],
      apps: { stripe: { enabled: true, credentialId: 7, price: 420000, currency: "czk" } },
    };

    const result = withPaypalAppData(metadata, stripeAppData);

    expect(result.apps).toEqual({
      stripe: metadata.apps.stripe,
      paypal: { enabled: true, price: 420000, currency: "CZK", paymentOption: "ON_BOOKING" },
    });
    // Other metadata is kept as-is.
    expect(result.organizerCcEmails).toEqual(["diana@example.com"]);
  });

  it("charges exactly what Stripe would: the app's own price/currency win over getPaymentAppData's", () => {
    // getPaymentAppData prefers the event type's price/currency columns (here the DB default "usd"),
    // but handlePayment charges Stripe bookings from metadata.apps.stripe.
    const metadata = { apps: { stripe: { enabled: true, price: 360000, currency: "eur" } } };

    const result = withPaypalAppData(metadata, { appId: "stripe", price: 420000, currency: "usd" });

    expect(result.apps.paypal).toEqual({
      enabled: true,
      price: 360000,
      currency: "EUR",
      paymentOption: "ON_BOOKING",
    });
  });

  it("does not mutate the event type's metadata", () => {
    const metadata = { apps: { stripe: { enabled: true, price: 100, currency: "czk" } } };
    withPaypalAppData(metadata, stripeAppData);
    expect(metadata.apps).not.toHaveProperty("paypal");
  });

  it("handles missing metadata or apps", () => {
    expect(withPaypalAppData(null, stripeAppData).apps).toEqual({
      paypal: { enabled: true, price: 420000, currency: "CZK", paymentOption: "ON_BOOKING" },
    });
    expect(withPaypalAppData({}, stripeAppData).apps).toHaveProperty("paypal");
  });
});

describe("getPaypalPaymentOverride", () => {
  it("returns the organizer's PayPal credential and metadata with a paypal entry", async () => {
    const { prismaClient, findFirst } = prismaWith(paypalCredential);

    const result = await getPaypalPaymentOverride({
      prismaClient,
      organizerUserId: 1,
      paymentAppData: stripeAppData,
      metadata: { apps: { stripe: { enabled: true, price: 420000, currency: "czk" } } },
    });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { appId: "paypal", userId: 1 } })
    );
    expect(result.credential).toBe(paypalCredential);
    expect(result.metadata.apps).toHaveProperty("paypal.price", 420000);
    expect(result.metadata.apps).toHaveProperty("paypal.currency", "CZK");
  });

  it("rejects PayPal for events that hold a card for a later charge (no-show fee)", async () => {
    const { prismaClient, findFirst } = prismaWith(paypalCredential);

    await expect(
      getPaypalPaymentOverride({
        prismaClient,
        organizerUserId: 1,
        paymentAppData: { ...stripeAppData, paymentOption: "HOLD" },
        metadata: {},
      })
    ).rejects.toMatchObject({ statusCode: 400, message: "PayPal is not available for this event" });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("fails with a 400 when the organizer hasn't connected PayPal", async () => {
    const { prismaClient } = prismaWith(null);

    const promise = getPaypalPaymentOverride({
      prismaClient,
      organizerUserId: 1,
      paymentAppData: stripeAppData,
      metadata: {},
    });

    await expect(promise).rejects.toBeInstanceOf(HttpError);
    await expect(promise).rejects.toMatchObject({
      statusCode: 400,
      message: "PayPal payment is not configured",
    });
  });
});
