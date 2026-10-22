import classNames from "@calcom/ui/classNames";

export function getBookerWrapperClasses({ isEmbed }: { isEmbed: boolean }) {
  // We don't want any margins for Embed. Any margin needed should be added by Embed user.
  return classNames(
    "flex h-full items-center justify-center",
    !isEmbed && "min-h-[calc(100dvh)] bg-cover bg-center bg-fixed"
  );
}

// Same background art used on thepathofinitiationprague.com/calendar, with the same dark
// veil gradient so the booking page reads as a continuation of that page rather than a
// third-party tool. Skipped in embed mode so an embedded booker doesn't duplicate whatever
// background the host page already has.
export function getBookerBackgroundStyle({ isEmbed }: { isEmbed: boolean }) {
  if (isEmbed) return undefined;
  return {
    backgroundImage:
      "linear-gradient(to bottom, rgba(0,0,0,0.7), rgba(0,0,0,0.85) 50%, rgba(0,0,0,0.95)), url('https://thepathofinitiationprague.com/images/art/starry-rhone-gogh.jpg')",
  };
}
