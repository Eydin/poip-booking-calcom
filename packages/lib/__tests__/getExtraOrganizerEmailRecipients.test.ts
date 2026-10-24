import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const organizer = {
  name: "Radu",
  email: "radu@example.com",
  timeZone: "Europe/Prague",
  language: { translate: ((key: string) => key) as never, locale: "en" },
};

async function loadWithEnv(value: string | undefined) {
  vi.resetModules();
  vi.stubEnv("BOOKING_ORGANIZER_CC_EMAILS", value ?? "");
  const { getExtraOrganizerEmailRecipients } = await import("../getExtraOrganizerEmailRecipients");
  return getExtraOrganizerEmailRecipients;
}

describe("getExtraOrganizerEmailRecipients", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an empty list when the env var is unset", async () => {
    const getExtraOrganizerEmailRecipients = await loadWithEnv(undefined);
    expect(getExtraOrganizerEmailRecipients({ organizer })).toEqual([]);
  });

  it("parses a comma-separated list into Person objects based on the organizer", async () => {
    const getExtraOrganizerEmailRecipients = await loadWithEnv(" diana@example.com, other@example.com ");
    const result = getExtraOrganizerEmailRecipients({ organizer });
    expect(result).toEqual([
      { ...organizer, email: "diana@example.com" },
      { ...organizer, email: "other@example.com" },
    ]);
  });

  it("filters out the organizer's own email to avoid a duplicate send", async () => {
    const getExtraOrganizerEmailRecipients = await loadWithEnv("radu@example.com, diana@example.com");
    const result = getExtraOrganizerEmailRecipients({ organizer });
    expect(result).toEqual([{ ...organizer, email: "diana@example.com" }]);
  });

  it("merges the site-wide env list with the event type's own CC list, deduped", async () => {
    const getExtraOrganizerEmailRecipients = await loadWithEnv("diana@example.com");
    const result = getExtraOrganizerEmailRecipients(
      { organizer },
      { organizerCcEmails: ["diana@example.com", "assistant@example.com"] }
    );
    expect(result).toEqual([
      { ...organizer, email: "diana@example.com" },
      { ...organizer, email: "assistant@example.com" },
    ]);
  });

  it("works from the event type's CC list alone, with no env var set", async () => {
    const getExtraOrganizerEmailRecipients = await loadWithEnv(undefined);
    const result = getExtraOrganizerEmailRecipients({ organizer }, { organizerCcEmails: ["diana@example.com"] });
    expect(result).toEqual([{ ...organizer, email: "diana@example.com" }]);
  });
});
