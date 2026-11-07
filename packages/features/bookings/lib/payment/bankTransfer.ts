import { convertFromSmallestToPresentableCurrencyUnit } from "@calcom/lib/currencyConversions";
import type { CalEventResponses } from "@calcom/types/Calendar";

export const BANK_TRANSFER_PAYMENT_METHOD_VALUE = "bank_transfer";

export function isBankTransferChosen(responses: CalEventResponses | null | undefined): boolean {
  return responses?.paymentMethod?.value === BANK_TRANSFER_PAYMENT_METHOD_VALUE;
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

export function buildSpaydString({
  iban,
  amountMinorUnits,
  currency,
  bookingId,
  message,
}: {
  iban: string;
  amountMinorUnits: number;
  currency: string;
  bookingId: number;
  message: string;
}): { spayd: string; variableSymbol: string; amount: string } {
  const amount = convertFromSmallestToPresentableCurrencyUnit(amountMinorUnits, currency).toFixed(2);
  const variableSymbol = String(bookingId).replace(/\D/g, "").slice(0, 10);
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
