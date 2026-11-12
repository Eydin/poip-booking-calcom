import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "vitest-fetch-mock";

import Paypal, { describePaypalError } from "./Paypal";

vi.mock("@calcom/prisma", () => ({
  default: {},
  prisma: {},
}));

const ORDER_ENDPOINT = "/v2/checkout/orders";

const createOrderWith = async ({
  amount,
  currency,
}: {
  amount: number;
  currency: string;
}): Promise<{ currency_code: string; value: string }> => {
  fetchMock.resetMocks();
  // First fetch is the OAuth token request, second is the order creation.
  fetchMock.mockResponseOnce(JSON.stringify({ access_token: "test-token", expires_in: 3600 }));
  fetchMock.mockResponseOnce(JSON.stringify({ id: "TEST_ORDER_ID" }));

  const paypal = new Paypal({ clientId: "test-client-id", secretKey: "test-secret-key" });

  await paypal.createOrder({
    referenceId: "test-reference-id",
    amount,
    currency,
    returnUrl: "https://example.com/return",
    cancelUrl: "https://example.com/cancel",
  });

  const orderCall = fetchMock.mock.calls.find(([url]) => String(url).includes(ORDER_ENDPOINT));
  if (!orderCall) throw new Error("Order creation request was never made");

  return JSON.parse(String(orderCall[1]?.body)).purchase_units[0].amount;
};

describe("Paypal.createOrder", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // JPY is stored unscaled by `convertToSmallestCurrencyUnit`, so the stored amount is
  // already the amount to charge. Scaling it down bills the attendee 1% of the price.
  it("sends JPY amounts unscaled", async () => {
    expect(await createOrderWith({ amount: 1000, currency: "JPY" })).toEqual({
      currency_code: "JPY",
      value: "1000",
    });
  });

  // HUF and TWD also reject decimals at PayPal, but `convertToSmallestCurrencyUnit` stores
  // them scaled, so they must keep going through the minor-unit conversion.
  // https://developer.paypal.com/api/rest/reference/currency-codes/
  it.each([
    { currency: "USD", amount: 1000, expected: "10" },
    { currency: "EUR", amount: 1050, expected: "10.5" },
    { currency: "HUF", amount: 5000, expected: "50" },
    { currency: "TWD", amount: 300, expected: "3" },
    { currency: "CZK", amount: 420000, expected: "4200" },
  ])("converts $currency amounts from minor units", async ({ currency, amount, expected }) => {
    expect(await createOrderWith({ amount, currency })).toEqual({
      currency_code: currency,
      value: expected,
    });
  });

  it("skips PayPal's shipping-address step and sends a description of at most 127 chars", async () => {
    fetchMock.resetMocks();
    fetchMock.mockResponseOnce(JSON.stringify({ access_token: "test-token", expires_in: 3600 }));
    fetchMock.mockResponseOnce(JSON.stringify({ id: "TEST_ORDER_ID" }));

    await newClient().createOrder({
      referenceId: "ref",
      amount: 420000,
      currency: "CZK",
      returnUrl: "https://example.com/return",
      cancelUrl: "https://example.com/cancel",
      description: "x".repeat(200),
    });

    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.payment_source.paypal.experience_context).toMatchObject({
      shipping_preference: "NO_SHIPPING",
      user_action: "PAY_NOW",
      return_url: "https://example.com/return",
      cancel_url: "https://example.com/cancel",
    });
    expect(body.purchase_units[0].description).toHaveLength(127);
  });

  it("omits the description when none is given", async () => {
    fetchMock.resetMocks();
    fetchMock.mockResponseOnce(JSON.stringify({ access_token: "test-token", expires_in: 3600 }));
    fetchMock.mockResponseOnce(JSON.stringify({ id: "TEST_ORDER_ID" }));

    await newClient().createOrder({
      referenceId: "ref",
      amount: 100,
      currency: "CZK",
      returnUrl: "https://example.com/return",
      cancelUrl: "https://example.com/cancel",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.purchase_units[0]).not.toHaveProperty("description");
  });
});

function newClient() {
  return new Paypal({ clientId: "test-client-id", secretKey: "test-secret-key" });
}

const TOKEN_RESPONSE = JSON.stringify({ access_token: "test-token", expires_in: 3600 });

const completedOrder = (captureId = "CAPTURE_1") =>
  JSON.stringify({
    id: "ORDER_1",
    status: "COMPLETED",
    purchase_units: [{ payments: { captures: [{ id: captureId, status: "COMPLETED" }] } }],
  });

const requestTo = (path: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(path));

describe("Paypal access token", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses the token for its whole lifetime (expires_in is in seconds)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fetchMock.resetMocks();
    fetchMock.mockResponse((req) =>
      Promise.resolve(req.url.endsWith("/v1/oauth2/token") ? TOKEN_RESPONSE : completedOrder())
    );

    const paypal = newClient();
    await paypal.getOrder("ORDER_1");
    vi.advanceTimersByTime(10 * 60 * 1000); // 10 minutes later, well within the hour
    await paypal.getOrder("ORDER_1");

    expect(requestTo("/v1/oauth2/token")).toHaveLength(1);
  });
});

describe("Paypal.captureOrder", () => {
  beforeEach(() => {
    fetchMock.resetMocks();
  });

  it("returns the capture id when the capture completes", async () => {
    fetchMock.mockResponses(TOKEN_RESPONSE, completedOrder("CAPTURE_42"));

    expect(await newClient().captureOrder("ORDER_1")).toEqual({ captureId: "CAPTURE_42" });

    const [captureCall] = requestTo("/v2/checkout/orders/ORDER_1/capture");
    expect(captureCall[1]?.method).toBe("POST");
    // Same idempotency key on every attempt, so a racing second capture can't double-charge.
    expect((captureCall[1]?.headers as Record<string, string>)["PayPal-Request-Id"]).toBe(
      "capture-ORDER_1"
    );
  });

  it("treats an already-captured order as completed by reading the order back", async () => {
    fetchMock.mockResponses(
      TOKEN_RESPONSE,
      [JSON.stringify({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] }), { status: 422 }],
      completedOrder("CAPTURE_7")
    );

    expect(await newClient().captureOrder("ORDER_1")).toEqual({ captureId: "CAPTURE_7" });
    expect(requestTo("/v2/checkout/orders/ORDER_1")).toHaveLength(1);
  });

  it("returns null when the order isn't completed", async () => {
    fetchMock.mockResponses(
      TOKEN_RESPONSE,
      [JSON.stringify({ details: [{ issue: "INSTRUMENT_DECLINED" }] }), { status: 422 }],
      JSON.stringify({ id: "ORDER_1", status: "APPROVED" })
    );

    expect(await newClient().captureOrder("ORDER_1")).toBeNull();
  });

  it("returns null when PayPal can't be reached at all", async () => {
    fetchMock.mockResponses(TOKEN_RESPONSE);
    fetchMock.mockReject(new Error("network down"));

    expect(await newClient().captureOrder("ORDER_1")).toBeNull();
  });

  it("returns a null capture id (not a failure) when a completed order has no capture listed", async () => {
    fetchMock.mockResponses(TOKEN_RESPONSE, JSON.stringify({ id: "ORDER_1", status: "COMPLETED" }));

    expect(await newClient().captureOrder("ORDER_1")).toEqual({ captureId: null });
  });
});

describe("Paypal.refundCapture", () => {
  beforeEach(() => {
    fetchMock.resetMocks();
  });

  it.each(["COMPLETED", "PENDING"])("succeeds when PayPal reports the refund as %s", async (status) => {
    fetchMock.mockResponses(TOKEN_RESPONSE, JSON.stringify({ id: "REFUND_1", status }));

    expect(await newClient().refundCapture("CAPTURE_1")).toEqual({ ok: true });

    const [refundCall] = requestTo("/v2/payments/captures/CAPTURE_1/refund");
    expect(refundCall[1]?.method).toBe("POST");
    expect((refundCall[1]?.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("refund-CAPTURE_1");
    // Empty body = refund the full captured amount.
    expect(JSON.parse(String(refundCall[1]?.body))).toEqual({});
  });

  it("passes on PayPal's reason when it rejects the refund (real live response: not enough balance)", async () => {
    const insufficientFunds = {
      name: "UNPROCESSABLE_ENTITY",
      message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
      details: [
        {
          issue: "REFUND_FAILED_INSUFFICIENT_FUNDS",
          description: "Capture could not be refunded due to insufficient funds.",
        },
      ],
    };
    fetchMock.mockResponses(TOKEN_RESPONSE, [JSON.stringify(insufficientFunds), { status: 422 }]);

    expect(await newClient().refundCapture("CAPTURE_1")).toEqual({
      ok: false,
      reason: "REFUND_FAILED_INSUFFICIENT_FUNDS: Capture could not be refunded due to insufficient funds.",
    });
  });

  it("fails when the refund is not accepted", async () => {
    fetchMock.mockResponses(TOKEN_RESPONSE, JSON.stringify({ id: "REFUND_1", status: "FAILED" }));

    expect(await newClient().refundCapture("CAPTURE_1")).toEqual({
      ok: false,
      reason: "PayPal reported the refund as FAILED",
    });
  });

  it("fails (without throwing) when PayPal can't be reached", async () => {
    fetchMock.mockResponses(TOKEN_RESPONSE);
    fetchMock.mockRejectOnce(new Error("network down"));

    // first mocked response is the token, the second call (refund) rejects
    const result = await newClient().refundCapture("CAPTURE_1");
    expect(result.ok).toBe(false);
  });
});

describe("describePaypalError", () => {
  it("uses the first detail's issue and description", () => {
    expect(
      describePaypalError(JSON.stringify({ name: "X", details: [{ issue: "ISSUE", description: "Why" }] }), 422)
    ).toBe("ISSUE: Why");
  });

  it("falls back to the error name and message", () => {
    expect(describePaypalError(JSON.stringify({ name: "NOT_AUTHORIZED", message: "No." }), 403)).toBe(
      "NOT_AUTHORIZED: No."
    );
  });

  it("falls back to the HTTP status for a non-JSON body", () => {
    expect(describePaypalError("<html>oops</html>", 502)).toBe("PayPal returned HTTP 502");
  });
});
