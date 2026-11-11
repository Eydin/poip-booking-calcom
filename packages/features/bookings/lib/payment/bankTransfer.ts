import { convertFromSmallestToPresentableCurrencyUnit } from "@calcom/lib/currencyConversions";
import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";

export const BANK_TRANSFER_PAYMENT_METHOD_VALUE = "bank_transfer";

/**
 * The option the booker picked in the "paymentMethod" booking field. Accepts both shapes the
 * booking flow passes around: CalEventResponses (`{ paymentMethod: { label, value } }`, used for
 * new bookings) and the raw form responses (`{ paymentMethod: "bank_transfer" }`, used when a
 * booker takes a seat in an existing seated booking).
 */
export function getChosenPaymentMethod(responses: unknown): string | undefined {
  if (!responses || typeof responses !== "object") return undefined;
  const response = (responses as Record<string, unknown>).paymentMethod;
  if (typeof response === "string") return response;
  if (response && typeof response === "object") {
    const value = (response as { value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function isBankTransferChosen(responses: unknown): boolean {
  return getChosenPaymentMethod(responses) === BANK_TRANSFER_PAYMENT_METHOD_VALUE;
}

export function getBankTransferConfig(): { iban: string; accountHolderName: string } | null {
  const iban = process.env.BANK_TRANSFER_IBAN;
  const accountHolderName = process.env.BANK_TRANSFER_ACCOUNT_HOLDER_NAME;
  if (!iban || !accountHolderName) return null;
  return { iban: iban.replace(/\s+/g, ""), accountHolderName };
}

// Strips anything outside printable ASCII - Czech SPAYD readers expect the MSG field to be ASCII.
function toAscii(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

/**
 * @param reference becomes the transfer's variable symbol (how a payment is matched to its
 *   booking): the booking id, or for a seat in a group class the attendee id - see
 *   saveSeatBankTransferDetails.
 */
export function buildSpaydString({
  iban,
  amountMinorUnits,
  currency,
  reference,
  message,
}: {
  iban: string;
  amountMinorUnits: number;
  currency: string;
  reference: number;
  message: string;
}): { spayd: string; variableSymbol: string; amount: string } {
  const amount = convertFromSmallestToPresentableCurrencyUnit(amountMinorUnits, currency).toFixed(2);
  const variableSymbol = String(reference).replace(/\D/g, "").slice(0, 10);
  const msg = toAscii(message).slice(0, 60);
  const spayd = `SPD*1.0*ACC:${iban}*AM:${amount}*CC:${currency.toUpperCase()}*MSG:${msg}*X-VS:${variableSymbol}`;
  return { spayd, variableSymbol, amount };
}

/**
 * Flat, string-valued keys only - Booking.metadata is validated by
 * bookingMetadataSchema (z.object({...}).and(z.record(z.string()))), so a
 * nested object here would fail to parse for the whole metadata blob.
 */
export function buildBankTransferBookingMetadata({
  iban,
  accountHolderName,
  spayd,
  variableSymbol,
  amount,
  currency,
}: {
  iban: string;
  accountHolderName: string;
  spayd: string;
  variableSymbol: string;
  amount: string;
  currency: string;
}): Record<string, string> {
  return {
    bankTransferSpayd: spayd,
    bankTransferIban: iban,
    bankTransferAccountHolderName: accountHolderName,
    bankTransferVariableSymbol: variableSymbol,
    bankTransferAmount: amount,
    bankTransferCurrency: currency.toUpperCase(),
  };
}

const BANK_TRANSFER_METADATA_KEYS = [
  "bankTransferSpayd",
  "bankTransferIban",
  "bankTransferAccountHolderName",
  "bankTransferVariableSymbol",
  "bankTransferAmount",
  "bankTransferCurrency",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * In a seated event (group class) every attendee shares one Booking, so bank-transfer details
 * can't live on the booking's metadata - every attendee's confirmation page would show them,
 * including people who paid by card, and all transfers would share the booking id as their
 * variable symbol. Instead they're stored on the attendee's own BookingSeat, with the attendee
 * id as the variable symbol so each person's transfer can be told apart.
 */
export async function saveSeatBankTransferDetails({
  prismaClient,
  seatReferenceUid,
  iban,
  accountHolderName,
  amountMinorUnits,
  currency,
  eventTitle,
}: {
  prismaClient: Pick<PrismaClient, "bookingSeat">;
  seatReferenceUid: string;
  iban: string;
  accountHolderName: string;
  amountMinorUnits: number;
  currency: string;
  eventTitle: string;
}): Promise<{ spayd: string; variableSymbol: string; amount: string }> {
  const seat = await prismaClient.bookingSeat.findUnique({
    where: { referenceUid: seatReferenceUid },
    select: { id: true, attendeeId: true, metadata: true },
  });
  if (!seat) {
    throw new Error(`Booking seat ${seatReferenceUid} not found`);
  }

  const { spayd, variableSymbol, amount } = buildSpaydString({
    iban,
    amountMinorUnits,
    currency,
    reference: seat.attendeeId,
    message: `${eventTitle} ${seatReferenceUid}`,
  });

  await prismaClient.bookingSeat.update({
    where: { id: seat.id },
    data: {
      metadata: {
        ...(isPlainObject(seat.metadata) ? seat.metadata : {}),
        ...buildBankTransferBookingMetadata({
          iban,
          accountHolderName,
          spayd,
          variableSymbol,
          amount,
          currency,
        }),
      } as Prisma.InputJsonValue,
    },
  });

  return { spayd, variableSymbol, amount };
}

/**
 * The booking metadata to show on a seated booking's confirmation page: only the viewing
 * attendee's own bank-transfer details (from their seat), never ones stored on the shared
 * booking - and none when it's viewed without a seat (e.g. by the host).
 */
export function withSeatBankTransferDetails(
  bookingMetadata: unknown,
  seatMetadata: unknown
): Record<string, unknown> {
  const metadata: Record<string, unknown> = isPlainObject(bookingMetadata) ? { ...bookingMetadata } : {};
  for (const key of BANK_TRANSFER_METADATA_KEYS) {
    delete metadata[key];
  }
  if (isPlainObject(seatMetadata)) {
    for (const key of BANK_TRANSFER_METADATA_KEYS) {
      if (typeof seatMetadata[key] === "string") metadata[key] = seatMetadata[key];
    }
  }
  return metadata;
}
