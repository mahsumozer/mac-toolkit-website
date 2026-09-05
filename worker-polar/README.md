# Mac Kit Polar Webhook Worker

Copy of `../worker` (the live Paddle/license worker) with a Polar webhook route added.
The original worker is untouched and keeps serving the app; this one only turns Polar
orders into licenses.

## Why a second worker

- The app validates licenses against `https://mac-kit-paddle-webhook.rojhot.workers.dev`,
  which is baked into every shipped build. That worker must keep running as is.
- Both workers bind the **same KV namespace** (`3a415125c7894a349ea433875f2c20e7`), so a
  license minted here is immediately valid for `/license/activate` on the original worker.
- The license, trial and admin endpoints are still present here (they came with the copy)
  but the app never calls them. Do not point the app at this worker.

## Endpoints

- Health check: `GET /health` → `providers: ["polar", "paddle"]`
- Polar webhook: `POST /polar/webhook`
- Everything else is identical to `../worker/README.md`.

## Polar Setup

Polar dashboard → Settings → Webhooks → Add Endpoint:

- URL: `https://mac-kit-polar-webhook.rojhot.workers.dev/polar/webhook`
- Format: **Raw**
- Events: `order.paid`, `order.refunded`, `subscription.active`, `subscription.updated`,
  `subscription.canceled`, `subscription.uncanceled`, `subscription.revoked`,
  `subscription.past_due`
- Generate the secret there and store it as a Worker secret:

```bash
wrangler secret put POLAR_WEBHOOK_SECRET
```

Signatures are verified per Standard Webhooks (`webhook-id`, `webhook-timestamp`,
`webhook-signature`; HMAC-SHA256 over `<id>.<timestamp>.<raw body>` keyed by the
base64-decoded secret). Secrets issued before 8 September 2026 used the raw secret string
as the key; both are tried. Tolerance: `POLAR_SIGNATURE_TOLERANCE_SECONDS` (300).

Do not put a proxy in front that rewrites the body.

## Secrets and variables

Secrets are per worker; the license email needs its own copy of the Resend settings:

```bash
wrangler secret put POLAR_WEBHOOK_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put ADMIN_API_KEY        # optional, for /admin/* here
wrangler secret put LICENSE_DEVICE_SALT  # optional; only /license/* uses it, keep equal to the original
```

Variables in `wrangler.toml`:

- `POLAR_LIFETIME_PRODUCT_ID`: Polar product ID of the lifetime product. Plan fallback for
  orders that carry no `plan` metadata (the checkout link sets `plan=lifetime`).
- `POLAR_MONTHLY_PRODUCT_ID`, `POLAR_YEARLY_PRODUCT_ID`: add when subscriptions are sold.
- The rest is inherited from the original worker (`LICENSE_EMAIL_FROM`, `MAC_KIT_DOWNLOAD_URL`,
  `LICENSE_ACTIVATION_LIMIT`, `MIN_SUPPORTED_VERSION`, ...).

Deploy:

```bash
wrangler deploy
```

## License flow

1. `order.paid` → `purchase:<order_id>` is stored and a `MACKIT-XXXX-XXXX-XXXX-XXXX` license
   is created (or the existing one found via `license_by_subscription:<subscription_id>` /
   `license_by_transaction:<order_id>` is refreshed). Customer email comes from
   `data.customer.email`; no Polar API call is made. `source: "polar"`.
2. The license email goes out through Resend exactly as for Paddle purchases.
3. `order.refunded` with `refunded_amount >= total_amount` on a **one-time** order sets the
   license to `refunded` (rejected by activation/status). Partial refunds and subscription
   orders are recorded under `purchase:<order_id>:refund` but leave the license alone.
4. `subscription.*` events map Polar statuses onto license statuses: `active`/`trialing`
   as is; `past_due`/`unpaid`/`incomplete` → `past_due`; `paused` → `paused`;
   `canceled` or `subscription.revoked` → `canceled`. A scheduled cancellation keeps the
   status `active` until Polar revokes it.

## Stored KV keys (new)

- `polar:event:<webhook-id>:received`: raw Polar event payload
- `polar:event:<webhook-id>:handled`: idempotency marker (Polar retries up to 10 times)
- `purchase:<order_id>:refund`: refund summary

## Testing

Sandbox: create the same product, checkout link and webhook on `sandbox.polar.sh`,
pointing at a separate deploy (`wrangler deploy --name mac-kit-polar-webhook-sandbox`
with its own KV namespace) so test licenses never land in production KV.

Production smoke test after deploy: Polar → Webhooks → endpoint → "Send test event" must
return 200 and write `polar:event:*` keys; then one real $14.90 purchase, activation in
the app, refund from the Polar dashboard, and `/license/status` on the original worker
returning `active: false`.
