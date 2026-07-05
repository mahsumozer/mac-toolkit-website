const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
};

const purchaseEvents = new Set(["transaction.completed"]);
const subscriptionEvents = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.canceled",
  "subscription.paused",
  "subscription.resumed",
  "subscription.past_due",
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "mac-kit-paddle-webhook" });
    }

    if (url.pathname !== "/paddle/webhook") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405, {
        allow: "POST",
      });
    }

    const rawBody = await request.text();
    const signatureHeader = request.headers.get("Paddle-Signature") || "";

    const signatureResult = await verifyPaddleSignature({
      rawBody,
      signatureHeader,
      secret: env.PADDLE_WEBHOOK_SECRET_KEY,
      toleranceSeconds: Number(env.PADDLE_SIGNATURE_TOLERANCE_SECONDS || 300),
    });

    if (!signatureResult.ok) {
      return json({ ok: false, error: signatureResult.error }, 401);
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const eventId = event.event_id || event.notification_id;
    if (!eventId || !event.event_type) {
      return json({ ok: false, error: "invalid_event" }, 400);
    }

    if (!env.PADDLE_EVENTS) {
      return json({ ok: false, error: "missing_paddle_events_kv" }, 500);
    }

    const handledKey = `paddle:event:${eventId}:handled`;
    const receivedKey = `paddle:event:${eventId}:received`;
    const alreadyHandled = await env.PADDLE_EVENTS.get(handledKey);

    if (alreadyHandled) {
      return json({ ok: true, duplicate: true, event_id: eventId });
    }

    await env.PADDLE_EVENTS.put(receivedKey, rawBody, {
      metadata: {
        event_type: event.event_type,
        occurred_at: event.occurred_at || null,
      },
    });

    ctx.waitUntil(processPaddleEvent(event, env, handledKey));

    return json({ ok: true, event_id: eventId, event_type: event.event_type });
  },
};

async function processPaddleEvent(event, env, handledKey) {
  if (purchaseEvents.has(event.event_type)) {
    await storePurchase(event, env);
  } else if (subscriptionEvents.has(event.event_type)) {
    await storeSubscription(event, env);
  }

  await env.PADDLE_EVENTS.put(
    handledKey,
    JSON.stringify({
      handled_at: new Date().toISOString(),
      event_id: event.event_id,
      event_type: event.event_type,
    })
  );
}

async function storePurchase(event, env) {
  const transaction = event.data || {};
  const transactionId = transaction.id;
  if (!transactionId) return;

  const customData = transaction.custom_data || {};
  const priceIds = extractPriceIds(transaction);
  const plan = customData.plan || inferPlan(priceIds, env);

  const purchase = {
    event_id: event.event_id,
    notification_id: event.notification_id || null,
    event_type: event.event_type,
    occurred_at: event.occurred_at || null,
    transaction_id: transactionId,
    customer_id: transaction.customer_id || null,
    subscription_id: transaction.subscription_id || null,
    status: transaction.status || null,
    currency_code: transaction.currency_code || null,
    total: transaction.details?.totals?.total || null,
    plan,
    price_ids: priceIds,
    custom_data: customData,
    stored_at: new Date().toISOString(),
  };

  await env.PADDLE_EVENTS.put(`purchase:${transactionId}`, JSON.stringify(purchase));

  if (transaction.subscription_id) {
    await env.PADDLE_EVENTS.put(
      `subscription:${transaction.subscription_id}:latest_purchase`,
      JSON.stringify(purchase)
    );
  }
}

async function storeSubscription(event, env) {
  const subscription = event.data || {};
  if (!subscription.id) return;

  const customData = subscription.custom_data || {};
  const priceIds = extractPriceIds(subscription);
  const plan = customData.plan || inferPlan(priceIds, env);

  await env.PADDLE_EVENTS.put(
    `subscription:${subscription.id}`,
    JSON.stringify({
      event_id: event.event_id,
      notification_id: event.notification_id || null,
      event_type: event.event_type,
      occurred_at: event.occurred_at || null,
      subscription_id: subscription.id,
      customer_id: subscription.customer_id || null,
      status: subscription.status || null,
      plan,
      price_ids: priceIds,
      custom_data: customData,
      stored_at: new Date().toISOString(),
    })
  );
}

function extractPriceIds(entity) {
  if (!Array.isArray(entity.items)) return [];

  return entity.items
    .map((item) => item.price_id || item.price?.id)
    .filter(Boolean);
}

function inferPlan(priceIds, env) {
  if (priceIds.includes(env.MONTHLY_PRICE_ID)) return "monthly";
  if (priceIds.includes(env.YEARLY_PRICE_ID)) return "yearly";
  return "unknown";
}

async function verifyPaddleSignature({
  rawBody,
  signatureHeader,
  secret,
  toleranceSeconds,
}) {
  if (!secret) return { ok: false, error: "missing_webhook_secret" };
  if (!signatureHeader) return { ok: false, error: "missing_signature" };

  const parsed = parsePaddleSignatureHeader(signatureHeader);
  if (!parsed.timestamp || parsed.signatures.length === 0) {
    return { ok: false, error: "invalid_signature_header" };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const eventSeconds = Number(parsed.timestamp);
  if (!Number.isFinite(eventSeconds)) {
    return { ok: false, error: "invalid_signature_timestamp" };
  }

  if (Math.abs(nowSeconds - eventSeconds) > toleranceSeconds) {
    return { ok: false, error: "stale_signature" };
  }

  const expectedSignature = await hmacSha256Hex(
    secret,
    `${parsed.timestamp}:${rawBody}`
  );

  const matches = parsed.signatures.some((signature) =>
    constantTimeEqual(expectedSignature, signature)
  );

  return matches ? { ok: true } : { ok: false, error: "signature_mismatch" };
}

function parsePaddleSignatureHeader(header) {
  const parsed = {
    timestamp: null,
    signatures: [],
  };

  header.split(";").forEach((part) => {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) return;

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();

    if (key === "ts") parsed.timestamp = value;
    if (key === "h1") parsed.signatures.push(value);
  });

  return parsed;
}

async function hmacSha256Hex(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );

  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left, right) {
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return diff === 0;
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...jsonHeaders,
      ...headers,
    },
  });
}
