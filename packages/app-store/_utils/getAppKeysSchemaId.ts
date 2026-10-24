/**
 * The generated appKeysSchemas map (packages/app-store/apps.keys-schemas.generated.ts)
 * is keyed by each app's dirName, except stripepayment, which is special-cased
 * to "stripe" by packages/app-store-cli/src/build.ts's getAppId:
 *
 *   const getAppId = (app) => (app.name === "stripepayment" ? "stripe" : app.name);
 *
 * Any runtime lookup into appKeysSchemas by dirName must go through this same
 * mapping, or it silently resolves to undefined for Stripe specifically.
 */
export function getAppKeysSchemaId(dirName: string): string {
  return dirName === "stripepayment" ? "stripe" : dirName;
}
