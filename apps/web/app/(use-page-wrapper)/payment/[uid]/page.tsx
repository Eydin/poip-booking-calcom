import { APP_NAME } from "@calcom/lib/constants";
import prisma from "@calcom/prisma";
import { buildLegacyCtx } from "@lib/buildLegacyCtx";
import type { PageProps } from "app/_types";
import { _generateMetadata } from "app/_utils";
import { withAppDirSsr } from "app/WithAppDirSsr";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { getClientSecretFromPaymentData } from "./getClientSecretFromPaymentData";
import PaymentPage from "./PaymentPage";

type PaymentPageProps = {
  payment: {
    id: number;
    success: boolean;
    refunded: boolean;
    amount: number;
    currency: string;
    paymentOption: string | null;
    data: Record<string, unknown>;
    appId?: string | null;
  };
  clientSecret?: string | null;
  booking: {
    id: number;
    uid: string;
    title: string;
    startTime: string;
    endTime: string;
    status: string;
    paid: boolean;
    description?: string | null;
    location?: string | null;
    attendeeEmail?: string | null;
  };
  eventType: {
    id: number;
    title: string;
    length: number;
    price: number;
    currency: string;
    metadata: Record<string, unknown> | null;
    successRedirectUrl?: string | null;
    forwardParamsSuccessRedirect?: boolean | null;
    recurringEvent?: unknown;
  };
  profile: { theme?: string | null; hideBranding?: boolean };
  user?: { name?: string | null; username?: string | null } | null;
};

const paramsSchema = z.object({ uid: z.string().min(1) });

export const generateMetadata = async ({ params, searchParams }: PageProps) => {
  const props = await getData(
    buildLegacyCtx(await headers(), await cookies(), await params, await searchParams)
  );
  const eventName = props.booking.title;
  return await _generateMetadata(
    (t) => `${t("payment")} | ${eventName} | ${APP_NAME}`,
    () => "",
    undefined,
    undefined,
    `/payment/${(await params).uid}`
  );
};

export const getServerSideProps: Parameters<typeof withAppDirSsr<PaymentPageProps>>[0] = async (
  context
) => {
  const parsedParams = paramsSchema.safeParse(context.params);
  if (!parsedParams.success) {
    return { notFound: true } as const;
  }

  const payment = await prisma.payment.findUnique({
    where: { uid: parsedParams.data.uid },
    select: {
      id: true,
      success: true,
      refunded: true,
      amount: true,
      currency: true,
      paymentOption: true,
      data: true,
      appId: true,
      booking: {
        select: {
          id: true,
          uid: true,
          title: true,
          description: true,
          startTime: true,
          endTime: true,
          status: true,
          paid: true,
          location: true,
          attendees: { select: { email: true }, take: 1 },
          user: { select: { name: true, username: true, theme: true, hideBranding: true } },
          eventType: {
            select: {
              id: true,
              title: true,
              length: true,
              price: true,
              currency: true,
              metadata: true,
              successRedirectUrl: true,
              forwardParamsSuccessRedirect: true,
              recurringEvent: true,
            },
          },
        },
      },
    },
  });

  if (!payment || !payment.booking) {
    return { notFound: true } as const;
  }

  const { booking } = payment;

  return {
    props: {
      payment: {
        id: payment.id,
        success: payment.success,
        refunded: payment.refunded,
        amount: payment.amount,
        currency: payment.currency,
        paymentOption: payment.paymentOption,
        data: payment.data as Record<string, unknown>,
        appId: payment.appId,
      },
      clientSecret: getClientSecretFromPaymentData(payment.paymentOption, payment.data),
      booking: {
        id: booking.id,
        uid: booking.uid,
        title: booking.title,
        description: booking.description,
        startTime: booking.startTime.toISOString(),
        endTime: booking.endTime.toISOString(),
        status: booking.status,
        paid: booking.paid,
        location: booking.location,
        attendeeEmail: booking.attendees[0]?.email ?? null,
      },
      eventType: {
        id: booking.eventType?.id ?? 0,
        title: booking.eventType?.title ?? booking.title,
        length: booking.eventType?.length ?? 0,
        price: booking.eventType?.price ?? payment.amount,
        currency: booking.eventType?.currency ?? payment.currency,
        metadata: (booking.eventType?.metadata as Record<string, unknown> | null) ?? null,
        successRedirectUrl: booking.eventType?.successRedirectUrl ?? null,
        forwardParamsSuccessRedirect: booking.eventType?.forwardParamsSuccessRedirect ?? null,
        recurringEvent: booking.eventType?.recurringEvent ?? null,
      },
      profile: {
        theme: booking.user?.theme ?? null,
        hideBranding: booking.user?.hideBranding ?? false,
      },
      user: booking.user ? { name: booking.user.name, username: booking.user.username } : null,
    },
  };
};

const getData = withAppDirSsr<PaymentPageProps>(getServerSideProps);

const ServerPage = async ({ params, searchParams }: PageProps) => {
  const props = await getData(
    buildLegacyCtx(await headers(), await cookies(), await params, await searchParams)
  );

  return <PaymentPage {...props} />;
};
export default ServerPage;
