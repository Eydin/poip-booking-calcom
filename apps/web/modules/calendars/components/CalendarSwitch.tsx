"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import classNames from "@calcom/ui/classNames";
import { Input, Switch } from "@calcom/ui/components/form";
import { ArrowLeftIcon, RotateCwIcon } from "@coss/ui/icons";
import { showToast } from "@calcom/ui/components/toast";
import type { ICalendarSwitchProps } from "@calcom/ui/components/calendar-switch";

type CalendarSwitchProps = ICalendarSwitchProps & {
  /**
   * AND-conflict-group this calendar currently belongs to, if any. Calendars sharing the same
   * group tag are only treated as busy when ALL of them are busy at once (useful for checking
   * two people's calendars at once on a shared booking page), instead of the default behaviour
   * of blocking a slot when ANY selected calendar is busy.
   */
  conflictGroupId?: string | null;
};

type UserCalendarSwitchProps = Omit<CalendarSwitchProps, "eventTypeId">;

type EventCalendarSwitchProps = CalendarSwitchProps & {
  eventTypeId: number;
};

const CalendarSwitch = (props: CalendarSwitchProps) => {
  const {
    title,
    externalId,
    type,
    isChecked,
    name,
    credentialId,
    delegationCredentialId,
    eventTypeId,
    disabled,
    conflictGroupId,
  } = props;
  const [checkedInternal, setCheckedInternal] = useState(isChecked);
  const [groupInput, setGroupInput] = useState(conflictGroupId ?? "");
  const utils = trpc.useUtils();
  const { t } = useLocale();
  const setConflictGroupMutation = trpc.viewer.calendars.setConflictGroup.useMutation({
    onSuccess: async () => {
      await utils.viewer.calendars.connectedCalendars.invalidate();
    },
    onError: () => {
      setGroupInput(conflictGroupId ?? "");
      showToast(`Something went wrong when updating the conflict group for "${title}"`, "error");
    },
  });
  const mutation = useMutation({
    mutationFn: async ({ isOn }: { isOn: boolean }) => {
      const body = {
        integration: type,
        externalId: externalId,
        ...(delegationCredentialId && { delegationCredentialId }),
        // new URLSearchParams does not accept numbers
        credentialId: String(credentialId),
        ...(eventTypeId ? { eventTypeId: String(eventTypeId) } : {}),
      };

      if (isOn) {
        const res = await fetch("/api/availability/calendar", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          throw new Error("Something went wrong");
        }
      } else {
        const res = await fetch(`/api/availability/calendar?${new URLSearchParams(body)}`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
          },
        });

        if (!res.ok) {
          throw new Error("Something went wrong");
        }
      }
    },
    async onSettled() {
      await utils.viewer.apps.integrations.invalidate();
      await utils.viewer.calendars.connectedCalendars.invalidate();
    },
    onError() {
      setCheckedInternal(false);
      showToast(`Something went wrong when toggling "${title}"`, "error");
    },
  });
  return (
    <div className={classNames("my-2 flex flex-row items-center")}>
      <div className="flex pl-2">
        <Switch
          id={externalId}
          checked={checkedInternal}
          disabled={disabled || mutation.isPending}
          onCheckedChange={async (isOn: boolean) => {
            setCheckedInternal(isOn);
            await mutation.mutate({ isOn });
          }}
        />
      </div>
      <label
        className={classNames(
          "ml-3 break-all text-sm font-medium leading-5",
          disabled ? "cursor-not-allowed opacity-25" : "cursor-pointer"
        )}
        htmlFor={externalId}>
        {name}
      </label>
      {!!props.destination && (
        <span className="bg-subtle text-default ml-8 inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-normal sm:ml-4">
          <ArrowLeftIcon className="h-4 w-4" />
          {t("adding_events_to")}
        </span>
      )}
      {mutation.isPending && (
        <RotateCwIcon className="text-muted h-4 w-4 animate-spin ltr:ml-1 rtl:mr-1" />
      )}
      {checkedInternal && (
        <div className="ml-4 flex items-center gap-1.5">
          <Input
            className="h-7 w-36 text-xs"
            placeholder="AND-group (optional)"
            disabled={disabled || setConflictGroupMutation.isPending}
            value={groupInput}
            onChange={(e) => setGroupInput(e.target.value)}
            onBlur={() => {
              const trimmed = groupInput.trim();
              if (trimmed === (conflictGroupId ?? "")) return;
              setConflictGroupMutation.mutate({
                integration: type,
                externalId,
                credentialId,
                conflictGroupId: trimmed || null,
              });
            }}
          />
          {setConflictGroupMutation.isPending && (
            <RotateCwIcon className="text-muted h-4 w-4 animate-spin" />
          )}
        </div>
      )}
    </div>
  );
};

export const UserCalendarSwitch = (props: UserCalendarSwitchProps) => {
  return <CalendarSwitch {...props} eventTypeId={null} />;
};

export const EventCalendarSwitch = (props: EventCalendarSwitchProps) => {
  return <CalendarSwitch {...props} />;
};

export { CalendarSwitch };
