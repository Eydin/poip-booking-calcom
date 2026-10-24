import { describe, it, expect } from "vitest";

import { getClientSecretFromPaymentData } from "../getClientSecretFromPaymentData";

describe("getClientSecretFromPaymentData", () => {
  it("extracts the top-level client_secret for ON_BOOKING payments", () => {
    const result = getClientSecretFromPaymentData("ON_BOOKING", {
      id: "pi_123",
      client_secret: "pi_123_secret_abc",
      status: "requires_payment_method",
    });

    expect(result).toBe("pi_123_secret_abc");
  });

  it("extracts the top-level client_secret when paymentOption is null (defaults to ON_BOOKING shape)", () => {
    const result = getClientSecretFromPaymentData(null, {
      id: "pi_123",
      client_secret: "pi_123_secret_abc",
    });

    expect(result).toBe("pi_123_secret_abc");
  });

  it("extracts the nested setupIntent.client_secret for HOLD payments", () => {
    const result = getClientSecretFromPaymentData("HOLD", {
      setupIntent: {
        id: "seti_456",
        client_secret: "seti_456_secret_xyz",
      },
      stripe_publishable_key: "pk_test",
      stripeAccount: "acct_123",
    });

    expect(result).toBe("seti_456_secret_xyz");
  });

  it("returns null for HOLD payments missing setupIntent", () => {
    const result = getClientSecretFromPaymentData("HOLD", {
      stripe_publishable_key: "pk_test",
    });

    expect(result).toBeNull();
  });

  it("returns null for ON_BOOKING payments missing client_secret", () => {
    const result = getClientSecretFromPaymentData("ON_BOOKING", {
      id: "pi_123",
      status: "succeeded",
    });

    expect(result).toBeNull();
  });

  it("returns null for null data", () => {
    expect(getClientSecretFromPaymentData("ON_BOOKING", null)).toBeNull();
  });

  it("returns null for a HOLD payment accidentally given ON_BOOKING-shaped data", () => {
    const result = getClientSecretFromPaymentData("HOLD", {
      id: "pi_123",
      client_secret: "pi_123_secret_abc",
    });

    expect(result).toBeNull();
  });
});
