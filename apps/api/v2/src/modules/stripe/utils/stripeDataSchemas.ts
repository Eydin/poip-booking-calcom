import { z } from "zod";

export const stripeOAuthTokenSchema = z.object({
  access_token: z.string().optional(),
  scope: z.string().optional(),
  livemode: z.boolean().optional(),
  token_type: z.literal("bearer").optional(),
  refresh_token: z.string().optional(),
  stripe_user_id: z.string().optional(),
  stripe_publishable_key: z.string().optional(),
});

export const stripeDataSchema = stripeOAuthTokenSchema.extend({
  default_currency: z.string(),
});

export type StripeData = z.infer<typeof stripeDataSchema>;

export const stripeKeysResponseSchema = z.object({
  client_id: z.string().startsWith("ca_").min(1),
  // Accepts a full secret key (sk_) or a restricted key (rk_) - Stripe
  // supports using either as the platform's own API key.
  client_secret: z
    .string()
    .min(1)
    .refine((val) => val.startsWith("sk_") || val.startsWith("rk_"), {
      message: 'Must start with "sk_" or "rk_"',
    }),
  public_key: z.string().startsWith("pk_").min(1),
  webhook_secret: z.string().startsWith("whsec_").min(1),
});
