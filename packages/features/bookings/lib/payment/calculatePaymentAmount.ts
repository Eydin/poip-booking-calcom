import { eventTypeMetaDataSchemaWithTypedApps } from "@calcom/app-store/zod-utils";
import type { Fields } from "@calcom/features/bookings/lib/getBookingFields";
import { fieldTypesConfigMap } from "@calcom/features/form-builder/fieldTypes";
import { convertToSmallestCurrencyUnit } from "@calcom/lib/currencyConversions";
import type { CalendarEvent } from "@calcom/types/Calendar";

export type PaymentAppPricing = {
  price?: number;
  currency?: string;
  paymentOption?: string;
  enabled?: boolean;
};

/** An app's entry in the event type's metadata, e.g. metadata.apps.stripe. */
export function getEventTypePaymentAppPricing(
  metadata: unknown,
  appId: string | null | undefined
): PaymentAppPricing | undefined {
  if (!appId) return undefined;
  const apps = eventTypeMetaDataSchemaWithTypedApps.parse(metadata)?.apps as
    | Record<string, PaymentAppPricing | undefined>
    | undefined;
  return apps?.[appId];
}

/**
 * What the booker is charged: the payment app's base price plus any priced booking-field
 * options they picked (e.g. Empower Thyself's "Pay in full" vs "Deposit" choice). Shared by
 * online payments (handlePayment) and the bank-transfer QR code so the two always agree.
 *
 * @returns amount in the currency's smallest unit
 */
export function calculatePaymentAmount({
  appData,
  bookingFields,
  responses,
  locale = "en",
}: {
  appData: PaymentAppPricing | undefined;
  bookingFields?: Fields | null;
  responses: CalendarEvent["responses"];
  locale?: string;
}): { amount: number; currency: string } {
  // Ensure we have a valid currency - fallback to USD if undefined
  const currency = appData?.currency || "USD";

  let totalAmount = appData?.price || 0;

  if ((bookingFields || [])?.length > 0) {
    let addonsPrice = 0;

    // Process each booking field
    (bookingFields || []).forEach((field) => {
      // Skip fields that don't support pricing
      if (
        !fieldTypesConfigMap[field.type]?.supportsPricing &&
        !fieldTypesConfigMap[field.type]?.optionsSupportPricing
      ) {
        return;
      }

      // Type assertion for price-related fields
      const typedInput = field as { price?: number; options?: { value: string; price?: number }[] };
      const response = responses?.[field.name];

      // Skip if no response for this field
      if (!response) return;

      switch (field.type) {
        case "number": {
          // Multiply the numeric value by the field's price
          const parsedValue = Number((response.value ?? "").toString().trim());
          const safeValue = Number.isFinite(parsedValue) ? parsedValue : 0;
          addonsPrice += safeValue * (typedInput.price || 0);
          break;
        }

        case "boolean": {
          // Add price if boolean field is true
          if (response.value) {
            addonsPrice += typedInput.price || 0;
          }
          break;
        }

        case "select":
        case "radio": {
          // For select and radio, find the selected option and add its price
          const selectedValue = response.value;
          let selectedOption;

          if (field.type === "radio") {
            // For radio, the value coming is the label itself (formatted with price)
            selectedOption = typedInput.options?.find((opt) => {
              const formattedValue = `${opt.value} (${Intl.NumberFormat(locale, {
                style: "currency",
                currency: currency,
              }).format(opt.price || 0)})`;
              return formattedValue === selectedValue;
            });
          } else {
            // For select, match by direct value
            selectedOption = typedInput.options?.find((opt) => opt.value === selectedValue);
          }

          addonsPrice += selectedOption?.price || 0;
          break;
        }

        case "checkbox":
        case "multiselect": {
          // For checkbox and multiselect, add prices of all selected options
          const responseValue = response.value;
          const selectedValues = Array.isArray(responseValue)
            ? responseValue
            : responseValue
              ? [responseValue]
              : [];

          selectedValues.forEach((value) => {
            const option = typedInput.options?.find((opt) => opt.value === value);
            addonsPrice += option?.price || 0;
          });
          break;
        }
      }
    });

    totalAmount += convertToSmallestCurrencyUnit(addonsPrice, currency);
  }

  return { amount: totalAmount, currency };
}

/**
 * What a booker paying outside the online payment apps (bank transfer) owes - the same amount
 * the event type's payment app would charge them.
 */
export function getBookerCharge({
  eventTypeMetadata,
  paymentAppData,
  bookingFields,
  responses,
  locale,
}: {
  eventTypeMetadata: unknown;
  paymentAppData: { appId: string | null; price: number; currency: string };
  bookingFields?: Fields | null;
  responses: CalendarEvent["responses"];
  locale?: string;
}): { amount: number; currency: string } {
  const appData = getEventTypePaymentAppPricing(eventTypeMetadata, paymentAppData.appId) ?? {
    price: paymentAppData.price,
    currency: paymentAppData.currency,
  };
  return calculatePaymentAmount({ appData, bookingFields, responses, locale });
}
