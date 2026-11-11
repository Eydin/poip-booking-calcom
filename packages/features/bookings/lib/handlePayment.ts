import { PaymentServiceMap } from "@calcom/app-store/payment.services.generated";
import type { EventTypeAppsList } from "@calcom/app-store/utils";
import type { Fields } from "@calcom/features/bookings/lib/getBookingFields";
import {
  calculatePaymentAmount,
  getEventTypePaymentAppPricing,
} from "@calcom/features/bookings/lib/payment/calculatePaymentAmount";
import type { AppCategories, Prisma, EventType, PaymentOption } from "@calcom/prisma/client";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { IAbstractPaymentService } from "@calcom/types/PaymentService";

const isPaymentService = (
  x: unknown
): x is { BuildPaymentService: (credentials: { key: unknown }) => unknown } =>
  !!x && typeof x === "object" && "BuildPaymentService" in x && typeof x.BuildPaymentService === "function";

const handlePayment = async ({
  evt,
  selectedEventType,
  paymentAppCredentials,
  booking,
  bookerName,
  bookerEmail,
  bookerPhoneNumber,
  isDryRun = false,
  bookingFields,
  locale = "en",
}: {
  evt: CalendarEvent;
  selectedEventType: Pick<EventType, "metadata" | "title">;
  paymentAppCredentials: {
    key: Prisma.JsonValue;
    appId: EventTypeAppsList;
    app: {
      dirName: string;
      categories: AppCategories[];
    } | null;
  };
  booking: {
    user: { email: string | null; name: string | null; timeZone: string; username: string | null } | null;
    id: number;
    userId: number | null;
    startTime: { toISOString: () => string };
    uid: string;
  };
  bookerName: string;
  bookerEmail: string;
  bookerPhoneNumber?: string | null;
  isDryRun?: boolean;
  bookingFields?: Fields;
  locale?: string;
}) => {
  if (isDryRun) return null;
  const key = paymentAppCredentials?.app?.dirName;

  const paymentAppImportFn = PaymentServiceMap[key as keyof typeof PaymentServiceMap];
  if (!paymentAppImportFn) {
    console.warn(`payment app not implemented for key: ${key}`);
    return null;
  }

  const paymentAppModule = await paymentAppImportFn;
  if (!isPaymentService(paymentAppModule)) {
    console.warn(`payment App service not found for key: ${key}`);
    return null;
  }
  const createPaymentService = paymentAppModule.BuildPaymentService;
  const paymentInstance = createPaymentService(paymentAppCredentials) as IAbstractPaymentService;

  const appData = getEventTypePaymentAppPricing(selectedEventType?.metadata, paymentAppCredentials.appId);

  const paymentOption = (appData?.paymentOption || "ON_BOOKING") as PaymentOption;

  const paymentPriceAndCurrency = calculatePaymentAmount({
    appData,
    bookingFields,
    responses: evt.responses,
    locale,
  });

  let paymentData;
  if (paymentOption === "HOLD") {
    paymentData = await paymentInstance.collectCard(
      paymentPriceAndCurrency,
      booking.id,
      paymentOption,
      bookerEmail,
      bookerPhoneNumber
    );
  } else {
    paymentData = await paymentInstance.create(
      paymentPriceAndCurrency,
      booking.id,
      booking.userId,
      booking.user?.username ?? null,
      bookerName,
      paymentOption,
      bookerEmail,
      bookerPhoneNumber,
      selectedEventType.title,
      evt.title
    );
  }

  if (!paymentData) {
    console.error("Payment data is null");
    throw new Error("Payment data is null");
  }
  try {
    await paymentInstance.afterPayment(evt, booking, paymentData, selectedEventType?.metadata);
  } catch (e) {
    console.error(e);
  }
  return paymentData;
};

export { handlePayment };
