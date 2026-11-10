// Same destination lists the main website's newsletter signup posts to
// (components/newsletter-section.tsx in the v0-the-path-of-initiation-prague repo).
const HUBSPOT_ENDPOINT =
  "https://api.hsforms.com/submissions/v3/integration/submit/244385888/1234d7eb-cafd-416c-ac29-891fcefedeb6";
const MAILERLITE_ENDPOINT = "https://static.mailerlite.com/webforms/submit/o1u2r8";

export async function subscribeToNewsletter(email: string): Promise<void> {
  await Promise.all([
    fetch(HUBSPOT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submittedAt: Date.now().toString(),
        fields: [{ objectTypeId: "0-1", name: "email", value: email }],
        context: {
          pageUri: window.location.href,
          pageName: document.title || "The Path of Initiation Prague",
        },
      }),
    }),
    fetch(MAILERLITE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        "fields[email]": email,
        "ml-submit": "1",
      }).toString(),
    }),
  ]);
}
