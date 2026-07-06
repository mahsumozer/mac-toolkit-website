# Mac Kit Paddle Webhook and License Worker

Cloudflare Worker for Paddle Billing webhooks and Mac Kit license activation.

## Endpoints

- Health check: `GET /health`
- Paddle webhook: `POST /paddle/webhook`
- License activation: `POST /license/activate`
- License status: `POST /license/status`
- License deactivation: `POST /license/deactivate`
- Admin license lookup/create: `GET /admin/license`, `POST /admin/licenses`
- Admin license email resend: `POST /admin/license/email`

Use one of these Paddle notification destination URLs:

- Workers.dev: `https://mac-kit-paddle-webhook.<your-account>.workers.dev/paddle/webhook`
- Custom route: `https://api.mackit.rojhot.com/paddle/webhook`

Do not attach this Worker to the same route as the public website unless you are intentionally routing API paths only.

## Cloudflare Setup

Create a KV namespace:

```bash
wrangler kv namespace create PADDLE_EVENTS
wrangler kv namespace create PADDLE_EVENTS --preview
```

Copy the returned IDs into `wrangler.toml`.

Set the Paddle notification destination secret as a Worker secret:

```bash
wrangler secret put PADDLE_WEBHOOK_SECRET_KEY
```

Set an admin API key. This is required for manual license lookup/backfill:

```bash
wrangler secret put ADMIN_API_KEY
```

Optional secrets:

```bash
wrangler secret put PADDLE_API_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put LICENSE_DEVICE_SALT
```

Optional variables:

- `LICENSE_EMAIL_FROM`: verified Resend sender, for example `Mac Kit <license@mackit.rojhot.com>`
- `LICENSE_EMAIL_REPLY_TO`: optional reply-to address for license emails
- `MAC_KIT_DOWNLOAD_URL`: download URL to include in license emails
- `LICENSE_ACTIVATION_LIMIT`: default device activation limit, defaults to `3`
- `PADDLE_ENVIRONMENT`: `live` or `sandbox`; used when fetching customer email from Paddle

Deploy:

```bash
wrangler deploy
```

## Paddle Setup

Create a notification destination in Paddle:

- URL: `https://.../paddle/webhook`
- Events:
  - `transaction.completed`
  - `subscription.created`
  - `subscription.updated`
  - `subscription.canceled`
  - `subscription.paused`
  - `subscription.resumed`
  - `subscription.past_due`

The Worker verifies the `Paddle-Signature` header using the raw request body. Do not put a proxy in front that rewrites the body.

## Stored KV Keys

- `paddle:event:<event_id>:received`: raw Paddle event payload
- `paddle:event:<event_id>:handled`: idempotency marker
- `purchase:<transaction_id>`: summarized successful purchase
- `subscription:<subscription_id>`: latest subscription state
- `subscription:<subscription_id>:latest_purchase`: latest purchase summary for a subscription
- `license:<license_key>`: license record used by the app
- `license_by_subscription:<subscription_id>`: subscription to license index
- `license_by_transaction:<transaction_id>`: transaction to license index
- `license_by_customer:<customer_id>`: Paddle customer to license index
- `license_by_email:<email>`: customer email to license index

## License Flow

When a verified `transaction.completed` or `subscription.created` event arrives, the Worker:

1. Stores the Paddle event.
2. Creates or updates a `MACKIT-XXXX-XXXX-XXXX-XXXX` license.
3. Indexes the license by subscription, transaction, customer, and email when available.
4. Optionally sends the license email through Resend when `RESEND_API_KEY` and `LICENSE_EMAIL_FROM` are configured.
5. Updates the license status when subscription webhook events arrive.

Active app access is allowed only for license statuses:

- `active`
- `trialing`

Statuses like `past_due`, `paused`, and `canceled` are rejected by activation/status endpoints.

## App API

Activate a device:

```http
POST /license/activate
Content-Type: application/json

{
  "license_key": "MACKIT-XXXX-XXXX-XXXX-XXXX",
  "device_id": "stable-installation-or-device-id",
  "device_name": "Mahsum's MacBook Pro",
  "app_version": "1.0.0"
}
```

Response:

```json
{
  "ok": true,
  "license": {
    "status": "active",
    "plan": "monthly",
    "subscription_id": "sub_...",
    "activation_limit": 3,
    "activations_used": 1
  }
}
```

Check status:

```http
POST /license/status
Content-Type: application/json

{
  "license_key": "MACKIT-XXXX-XXXX-XXXX-XXXX",
  "device_id": "stable-installation-or-device-id"
}
```

Deactivate a device:

```http
POST /license/deactivate
Content-Type: application/json

{
  "license_key": "MACKIT-XXXX-XXXX-XXXX-XXXX",
  "device_id": "stable-installation-or-device-id"
}
```

## Admin Backfill

Webhook events that were already delivered before this code was deployed will not automatically generate a license. Either resend the Paddle notification or create a license manually:

```bash
curl -X POST "https://mac-kit-paddle-webhook.rojhot.workers.dev/admin/licenses" \
  -H "authorization: Bearer $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "email": "customer@example.com",
    "subscription_id": "sub_...",
    "customer_id": "ctm_...",
    "plan": "monthly",
    "status": "active"
  }'
```

Lookup:

```bash
curl "https://mac-kit-paddle-webhook.rojhot.workers.dev/admin/license?email=customer@example.com" \
  -H "authorization: Bearer $ADMIN_API_KEY"
```

Resend a license email:

```bash
curl -X POST "https://mac-kit-paddle-webhook.rojhot.workers.dev/admin/license/email" \
  -H "authorization: Bearer $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "email": "customer@example.com"
  }'
```

If the license has no email address yet, target it by license/subscription/transaction and include the email:

```bash
curl -X POST "https://mac-kit-paddle-webhook.rojhot.workers.dev/admin/license/email" \
  -H "authorization: Bearer $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "subscription_id": "sub_...",
    "email": "customer@example.com"
  }'
```
