/**
 * Opt-in smoke test against the real PayPal sandbox (skipped unless sandbox keys are set):
 *
 *   PAYPAL_SANDBOX_CLIENT_ID=... PAYPAL_SANDBOX_SECRET=... TZ=UTC yarn vitest run packages/app-store/paypal/lib/Paypal.sandbox.test.ts
 *
 * Without a buyer it checks order creation and that an unapproved order isn't treated as paid.
 * To also check capture + refund: approve the printed order's link with a sandbox *buyer*
 * account, then re-run with PAYPAL_SANDBOX_APPROVED_ORDER_ID=<that order id>.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import Paypal from "./Paypal";

const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID;
const secretKey = process.env.PAYPAL_SANDBOX_SECRET;
const approvedOrderId = process.env.PAYPAL_SANDBOX_APPROVED_ORDER_ID;

describe.skipIf(!clientId || !secretKey)("PayPal sandbox smoke test", () => {
  const paypal = () => new Paypal({ clientId: clientId ?? "", secretKey: secretKey ?? "" });

  beforeAll(() => {
    // The shared vitest setup mocks fetch globally; this test needs the real network.
    fetchMock.disableMocks();
  });
  afterAll(() => {
    fetchMock.enableMocks();
  });

  it("authenticates", async () => {
    expect(await paypal().test()).toBe(true);
  });

  it.skipIf(!!approvedOrderId)(
    "creates a CZK order without a shipping step, and doesn't treat it as paid before approval",
    async () => {
      const client = paypal();
      const order = await client.createOrder({
        referenceId: `sandbox-smoke-${Date.now()}`,
        amount: 420000,
        currency: "CZK",
        returnUrl: "https://booking.example.com/api/integrations/paypal/capture?bookingUid=smoke",
        cancelUrl: "https://booking.example.com/payment/smoke",
        description: "Sacred Geometry 1 Class (sandbox smoke test)",
      });

      expect(order.id).toBeTruthy();
      expect(order.status).toBe("PAYER_ACTION_REQUIRED");
      const approveLink = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
      expect(approveLink).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
      console.log(`[paypal sandbox] order ${order.id} - approve as a sandbox buyer at: ${approveLink}`);

      // Not approved yet: capture must report "not completed", not success.
      expect(await client.captureOrder(order.id)).toBeNull();

      const fetched = await client.getOrder(order.id);
      expect(fetched?.status).toBe("PAYER_ACTION_REQUIRED");
    },
    30000
  );

  it.skipIf(!approvedOrderId)(
    "captures an approved order once, then refunds it in full",
    async () => {
      const client = paypal();

      const capture = await client.captureOrder(approvedOrderId ?? "");
      expect(capture?.captureId).toBeTruthy();

      // A second capture (e.g. the webhook racing the booker's return) still reports success.
      const again = await client.captureOrder(approvedOrderId ?? "");
      expect(again?.captureId).toBe(capture?.captureId);

      expect(await client.refundCapture(capture?.captureId ?? "")).toBe(true);
      // Refunding again is idempotent (same PayPal-Request-Id).
      expect(await client.refundCapture(capture?.captureId ?? "")).toBe(true);
    },
    30000
  );
});
