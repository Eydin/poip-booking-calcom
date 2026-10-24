import { describe, it, expect, vi } from "vitest";

vi.mock("@calcom/lib/constants", () => ({
  WEBAPP_URL: "https://booking.thepathofinitiationprague.com",
}));

import { buildConfirmReturnUrl } from "../StripePaymentComponent";

describe("buildConfirmReturnUrl", () => {
  it("builds the booking success URL Stripe redirects back to after confirming payment", () => {
    expect(buildConfirmReturnUrl("booking-uid-123")).toBe(
      "https://booking.thepathofinitiationprague.com/booking/booking-uid-123"
    );
  });
});
