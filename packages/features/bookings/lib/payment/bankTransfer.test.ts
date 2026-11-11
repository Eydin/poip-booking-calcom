import prismock from "@calcom/testing/lib/__mocks__/prisma";
import { beforeEach, describe, expect, it } from "vitest";

// Importing @calcom/prisma is what starts the in-memory prismock database used below.
import "@calcom/prisma";

import {
  buildSpaydString,
  getChosenPaymentMethod,
  saveSeatBankTransferDetails,
  withSeatBankTransferDetails,
} from "./bankTransfer";

const IBAN = "CZ6508000000192000145399";

const bankTransferKeys = (variableSymbol: string) => ({
  bankTransferSpayd: expect.stringContaining(`X-VS:${variableSymbol}`),
  bankTransferIban: IBAN,
  bankTransferAccountHolderName: "Test Holder",
  bankTransferVariableSymbol: variableSymbol,
  bankTransferAmount: "4200.00",
  bankTransferCurrency: "CZK",
});

describe("getChosenPaymentMethod", () => {
  it("reads both labelled (CalEventResponses) and raw responses", () => {
    expect(getChosenPaymentMethod({ paymentMethod: { label: "Bank", value: "bank_transfer" } })).toBe(
      "bank_transfer"
    );
    expect(getChosenPaymentMethod({ paymentMethod: "paypal" })).toBe("paypal");
  });

  it("ignores anything else", () => {
    expect(getChosenPaymentMethod(undefined)).toBeUndefined();
    expect(getChosenPaymentMethod("bank_transfer")).toBeUndefined();
    expect(getChosenPaymentMethod({})).toBeUndefined();
    expect(getChosenPaymentMethod({ paymentMethod: ["bank_transfer"] })).toBeUndefined();
    expect(getChosenPaymentMethod({ paymentMethod: { value: 1 } })).toBeUndefined();
  });
});

describe("buildSpaydString", () => {
  it("uses the reference as the variable symbol and formats the amount in major units", () => {
    const result = buildSpaydString({
      iban: IBAN,
      amountMinorUnits: 420000,
      currency: "czk",
      reference: 1234,
      message: "Sacred Geometry 1 Class abc",
    });

    expect(result).toEqual({
      variableSymbol: "1234",
      amount: "4200.00",
      spayd: `SPD*1.0*ACC:${IBAN}*AM:4200.00*CC:CZK*MSG:Sacred Geometry 1 Class abc*X-VS:1234`,
    });
  });

  it("keeps the payment message ASCII-only and at most 60 characters", () => {
    const { spayd } = buildSpaydString({
      iban: IBAN,
      amountMinorUnits: 100,
      currency: "CZK",
      reference: 1,
      message: `Posvátná geometrie ${"x".repeat(80)}`,
    });

    const msg = /MSG:([^*]*)/.exec(spayd)?.[1] ?? "";
    expect(msg.startsWith("Posvatna geometrie")).toBe(true);
    expect(msg).toHaveLength(60);
  });
});

describe("withSeatBankTransferDetails", () => {
  const sharedBookingMetadata = {
    videoCallUrl: "https://example.com/call",
    // Left on the shared booking by an older version (or another attendee).
    bankTransferSpayd: "SPD*someone-else",
    bankTransferVariableSymbol: "1",
  };

  it("shows only the viewing attendee's own details and keeps the rest of the metadata", () => {
    const seatMetadata = {
      bankTransferSpayd: "SPD*mine",
      bankTransferVariableSymbol: "57",
      bankTransferIban: IBAN,
      unrelated: "not copied",
    };

    expect(withSeatBankTransferDetails(sharedBookingMetadata, seatMetadata)).toEqual({
      videoCallUrl: "https://example.com/call",
      bankTransferSpayd: "SPD*mine",
      bankTransferVariableSymbol: "57",
      bankTransferIban: IBAN,
    });
  });

  it("shows no bank-transfer details to an attendee who paid another way, or to the host", () => {
    expect(withSeatBankTransferDetails(sharedBookingMetadata, {})).toEqual({
      videoCallUrl: "https://example.com/call",
    });
    expect(withSeatBankTransferDetails(sharedBookingMetadata, null)).toEqual({
      videoCallUrl: "https://example.com/call",
    });
  });

  it("copes with missing or malformed metadata", () => {
    expect(withSeatBankTransferDetails(null, undefined)).toEqual({});
    expect(withSeatBankTransferDetails([], { bankTransferSpayd: 42 })).toEqual({});
  });

  it("doesn't mutate the booking's metadata", () => {
    const metadata = { ...sharedBookingMetadata };
    withSeatBankTransferDetails(metadata, {});
    expect(metadata).toEqual(sharedBookingMetadata);
  });
});

describe("saveSeatBankTransferDetails", () => {
  beforeEach(async () => {
    await prismock.bookingSeat.deleteMany();
  });

  async function seedSeat(metadata: Record<string, unknown> | null = null) {
    return prismock.bookingSeat.create({
      data: {
        referenceUid: "seat-ref-1",
        bookingId: 10,
        attendeeId: 57,
        data: {},
        ...(metadata ? { metadata } : {}),
      },
    });
  }

  it("stores the details on the seat, using the attendee id as variable symbol", async () => {
    await seedSeat({ existing: "kept" });

    const result = await saveSeatBankTransferDetails({
      prismaClient: prismock,
      seatReferenceUid: "seat-ref-1",
      iban: IBAN,
      accountHolderName: "Test Holder",
      amountMinorUnits: 420000,
      currency: "czk",
      eventTitle: "Sacred Geometry 1 Class",
    });

    expect(result.variableSymbol).toBe("57");
    expect(result.spayd).toContain("MSG:Sacred Geometry 1 Class seat-ref-1");
    const seat = await prismock.bookingSeat.findUnique({ where: { referenceUid: "seat-ref-1" } });
    expect(seat?.metadata).toEqual({ existing: "kept", ...bankTransferKeys("57") });
  });

  it("fails when the seat doesn't exist", async () => {
    await expect(
      saveSeatBankTransferDetails({
        prismaClient: prismock,
        seatReferenceUid: "missing",
        iban: IBAN,
        accountHolderName: "Test Holder",
        amountMinorUnits: 420000,
        currency: "czk",
        eventTitle: "Sacred Geometry 1 Class",
      })
    ).rejects.toThrow("Booking seat missing not found");
  });
});
