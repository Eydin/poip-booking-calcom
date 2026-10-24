import { describe, it, expect } from "vitest";

import { getAppKeysSchemaId } from "../getAppKeysSchemaId";

describe("getAppKeysSchemaId", () => {
  it("maps the stripepayment dirName to the generated map's special-cased 'stripe' key", () => {
    expect(getAppKeysSchemaId("stripepayment")).toBe("stripe");
  });

  it("returns every other dirName unchanged", () => {
    expect(getAppKeysSchemaId("alby")).toBe("alby");
    expect(getAppKeysSchemaId("paypal")).toBe("paypal");
    expect(getAppKeysSchemaId("mock-payment-app")).toBe("mock-payment-app");
    expect(getAppKeysSchemaId("pipedrive-crm")).toBe("pipedrive-crm");
  });
});
