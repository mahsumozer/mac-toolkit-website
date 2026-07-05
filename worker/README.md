# Mac Kit Paddle Webhook Worker

Cloudflare Worker for Paddle Billing webhooks.

## Endpoint

- Health check: `GET /health`
- Paddle webhook: `POST /paddle/webhook`

Use one of these Paddle notification destination URLs:

- Workers.dev: `https://mac-kit-paddle-webhook.<your-account>.workers.dev/paddle/webhook`
- Custom route: `https://mackit.rojhot.com/paddle/webhook`

The custom route only works if `mackit.rojhot.com` is proxied through Cloudflare and the route is attached to this Worker.

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

## Next Fulfillment Step

The Worker currently records verified purchases. The next step is to add fulfillment in `storePurchase()`:

- generate a license key,
- send a download/license email,
- or call an existing app backend to unlock access.
