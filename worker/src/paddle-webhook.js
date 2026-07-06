const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
};

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
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

const activeLicenseStatuses = new Set(["active", "trialing"]);
const licensePrefix = "MACKIT";
const licenseAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "mac-kit-paddle-webhook" });
    }

    if (url.pathname === "/license/activate") {
      return handleLicenseActivate(request, env);
    }

    if (url.pathname === "/license/status") {
      return handleLicenseStatus(request, env);
    }

    if (url.pathname === "/license/deactivate") {
      return handleLicenseDeactivate(request, env);
    }

    if (
      url.pathname === "/admin/license" ||
      url.pathname === "/admin/licenses" ||
      url.pathname === "/admin/license/email"
    ) {
      return handleAdminLicense(request, env, url);
    }

    if (url.pathname === "/paddle/webhook") {
      return handlePaddleWebhook(request, env, ctx);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
};

async function handlePaddleWebhook(request, env, ctx) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405, {
      allow: "POST",
    });
  }

  const kvError = ensureKv(env);
  if (kvError) return kvError;

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
}

async function processPaddleEvent(event, env, handledKey) {
  let processError = null;

  try {
    if (purchaseEvents.has(event.event_type)) {
      await storePurchase(event, env);
    } else if (subscriptionEvents.has(event.event_type)) {
      await storeSubscription(event, env);
    }
  } catch (error) {
    processError = serializeError(error);
  }

  await env.PADDLE_EVENTS.put(
    handledKey,
    JSON.stringify({
      handled_at: new Date().toISOString(),
      event_id: event.event_id,
      event_type: event.event_type,
      process_error: processError,
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
  const customerEmail = await resolveCustomerEmail(transaction, env);

  const purchase = {
    event_id: event.event_id,
    notification_id: event.notification_id || null,
    event_type: event.event_type,
    occurred_at: event.occurred_at || null,
    transaction_id: transactionId,
    customer_id: transaction.customer_id || null,
    customer_email: customerEmail,
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

  await ensureLicenseForPurchase(purchase, transaction, env);
}

async function storeSubscription(event, env) {
  const subscription = event.data || {};
  if (!subscription.id) return;

  const customData = subscription.custom_data || {};
  const priceIds = extractPriceIds(subscription);
  const plan = customData.plan || inferPlan(priceIds, env);
  const customerEmail = await resolveCustomerEmail(subscription, env);

  const subscriptionSummary = {
    event_id: event.event_id,
    notification_id: event.notification_id || null,
    event_type: event.event_type,
    occurred_at: event.occurred_at || null,
    subscription_id: subscription.id,
    customer_id: subscription.customer_id || null,
    customer_email: customerEmail,
    status: subscription.status || null,
    license_status: mapSubscriptionStatus(subscription.status, event.event_type),
    plan,
    price_ids: priceIds,
    custom_data: customData,
    current_period_ends_at: getSubscriptionPeriodEnd(subscription),
    stored_at: new Date().toISOString(),
  };

  await env.PADDLE_EVENTS.put(
    `subscription:${subscription.id}`,
    JSON.stringify(subscriptionSummary)
  );

  await ensureLicenseForSubscription(subscriptionSummary, subscription, env);
}

async function ensureLicenseForPurchase(purchase, transaction, env) {
  const lookupKey =
    (purchase.subscription_id &&
      (await env.PADDLE_EVENTS.get(`license_by_subscription:${purchase.subscription_id}`))) ||
    (await env.PADDLE_EVENTS.get(`license_by_transaction:${purchase.transaction_id}`));

  const now = new Date().toISOString();
  let license = lookupKey ? await getLicenseByKey(lookupKey, env) : null;

  if (!license) {
    license = createLicenseRecord({
      source: "paddle",
      status: "active",
      plan: purchase.plan,
      customerId: purchase.customer_id,
      customerEmail: purchase.customer_email,
      subscriptionId: purchase.subscription_id,
      transactionId: purchase.transaction_id,
      priceIds: purchase.price_ids,
      currentPeriodEndsAt: getSubscriptionPeriodEnd(transaction),
      env,
      now,
    });
  } else {
    license = mergeLicense(license, {
      status: activeLicenseStatuses.has(license.status) ? license.status : "active",
      plan: purchase.plan,
      customer_id: purchase.customer_id,
      customer_email: purchase.customer_email,
      subscription_id: purchase.subscription_id,
      transaction_id: purchase.transaction_id,
      price_ids: purchase.price_ids,
      current_period_ends_at: license.current_period_ends_at || getSubscriptionPeriodEnd(transaction),
      updated_at: now,
    });
  }

  license.latest_purchase_event_id = purchase.event_id;
  license.latest_transaction_id = purchase.transaction_id;
  license.last_payment_at = purchase.occurred_at || now;

  await storeLicense(license, env);
  await storeLicenseIndexes(license, env);
  await maybeSendLicenseEmail(license, env);

  return license;
}

async function ensureLicenseForSubscription(subscriptionSummary, subscription, env) {
  const lookupKey = await env.PADDLE_EVENTS.get(
    `license_by_subscription:${subscriptionSummary.subscription_id}`
  );
  const now = new Date().toISOString();
  let license = lookupKey ? await getLicenseByKey(lookupKey, env) : null;
  const nextStatus = subscriptionSummary.license_status || "unknown";

  if (!license) {
    license = createLicenseRecord({
      source: "paddle",
      status: nextStatus,
      plan: subscriptionSummary.plan,
      customerId: subscriptionSummary.customer_id,
      customerEmail: subscriptionSummary.customer_email,
      subscriptionId: subscriptionSummary.subscription_id,
      transactionId: null,
      priceIds: subscriptionSummary.price_ids,
      currentPeriodEndsAt: getSubscriptionPeriodEnd(subscription),
      env,
      now,
    });
  } else {
    license = mergeLicense(license, {
      status: nextStatus,
      plan: subscriptionSummary.plan,
      customer_id: subscriptionSummary.customer_id,
      customer_email: subscriptionSummary.customer_email,
      subscription_id: subscriptionSummary.subscription_id,
      price_ids: subscriptionSummary.price_ids,
      current_period_ends_at: getSubscriptionPeriodEnd(subscription),
      updated_at: now,
    });
  }

  license.latest_subscription_event_id = subscriptionSummary.event_id;
  license.latest_subscription_status = subscriptionSummary.status;

  await storeLicense(license, env);
  await storeLicenseIndexes(license, env);
  await maybeSendLicenseEmail(license, env);

  return license;
}

function createLicenseRecord({
  source,
  status,
  plan,
  customerId,
  customerEmail,
  subscriptionId,
  transactionId,
  priceIds,
  currentPeriodEndsAt,
  env,
  now,
}) {
  const licenseKey = generateLicenseKey();

  return {
    license_key: licenseKey,
    source,
    status,
    plan: plan || "unknown",
    customer_id: customerId || null,
    customer_email: normalizeEmail(customerEmail),
    subscription_id: subscriptionId || null,
    transaction_id: transactionId || null,
    price_ids: Array.isArray(priceIds) ? priceIds : [],
    current_period_ends_at: currentPeriodEndsAt || null,
    activation_limit: Number(env.LICENSE_ACTIVATION_LIMIT || 3),
    activations: [],
    fulfillment_status: "created",
    created_at: now,
    updated_at: now,
  };
}

function mergeLicense(license, updates) {
  const merged = { ...license };

  Object.entries(updates).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    merged[key] = value;
  });

  if (!Array.isArray(merged.activations)) merged.activations = [];
  return merged;
}

async function handleLicenseActivate(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405, {
      allow: "POST",
    });
  }

  const kvError = ensureKv(env);
  if (kvError) return kvError;

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "invalid_json" }, 400);

  const licenseKey = normalizeLicenseKey(body.license_key || body.licenseKey);
  const deviceId = String(body.device_id || body.deviceId || "").trim();

  if (!licenseKey) return json({ ok: false, error: "missing_license_key" }, 400);
  if (!deviceId) return json({ ok: false, error: "missing_device_id" }, 400);

  const license = await getLicenseByKey(licenseKey, env);
  if (!license) return json({ ok: false, error: "invalid_license" }, 404);

  if (!isLicenseUsable(license)) {
    return json(
      { ok: false, error: "license_not_active", status: license.status || "unknown" },
      403
    );
  }

  const now = new Date().toISOString();
  const deviceHash = await hashDeviceId(deviceId, env);
  const activations = Array.isArray(license.activations) ? license.activations : [];
  const activationLimit = Number(license.activation_limit || env.LICENSE_ACTIVATION_LIMIT || 3);
  const existing = activations.find((activation) => activation.device_hash === deviceHash);

  if (existing) {
    existing.status = "active";
    existing.last_seen_at = now;
    existing.device_name = sanitizeString(body.device_name || body.deviceName || existing.device_name, 120);
    existing.app_version = sanitizeString(body.app_version || body.appVersion || existing.app_version, 80);
  } else {
    const activeActivations = activations.filter((activation) => activation.status === "active");
    if (activeActivations.length >= activationLimit) {
      return json(
        {
          ok: false,
          error: "activation_limit_reached",
          activation_limit: activationLimit,
        },
        403
      );
    }

    activations.push({
      id: `act_${crypto.randomUUID()}`,
      device_hash: deviceHash,
      device_name: sanitizeString(body.device_name || body.deviceName, 120),
      app_version: sanitizeString(body.app_version || body.appVersion, 80),
      status: "active",
      activated_at: now,
      last_seen_at: now,
    });
  }

  license.activations = activations;
  license.updated_at = now;

  await storeLicense(license, env);

  return json({
    ok: true,
    license: publicLicenseResponse(license),
  });
}

async function handleLicenseStatus(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405, {
      allow: "POST",
    });
  }

  const kvError = ensureKv(env);
  if (kvError) return kvError;

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "invalid_json" }, 400);

  const licenseKey = normalizeLicenseKey(body.license_key || body.licenseKey);
  const deviceId = String(body.device_id || body.deviceId || "").trim();

  if (!licenseKey) return json({ ok: false, error: "missing_license_key" }, 400);

  const license = await getLicenseByKey(licenseKey, env);
  if (!license) return json({ ok: false, error: "invalid_license" }, 404);

  let deviceActive = null;
  if (deviceId) {
    const deviceHash = await hashDeviceId(deviceId, env);
    const activation = (license.activations || []).find(
      (item) => item.device_hash === deviceHash
    );
    deviceActive = activation?.status === "active";

    if (activation) {
      activation.last_seen_at = new Date().toISOString();
      license.updated_at = activation.last_seen_at;
      await storeLicense(license, env);
    }
  }

  return json({
    ok: true,
    active: isLicenseUsable(license) && deviceActive !== false,
    device_active: deviceActive,
    license: publicLicenseResponse(license),
  });
}

async function handleLicenseDeactivate(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405, {
      allow: "POST",
    });
  }

  const kvError = ensureKv(env);
  if (kvError) return kvError;

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "invalid_json" }, 400);

  const licenseKey = normalizeLicenseKey(body.license_key || body.licenseKey);
  const deviceId = String(body.device_id || body.deviceId || "").trim();

  if (!licenseKey) return json({ ok: false, error: "missing_license_key" }, 400);
  if (!deviceId) return json({ ok: false, error: "missing_device_id" }, 400);

  const license = await getLicenseByKey(licenseKey, env);
  if (!license) return json({ ok: false, error: "invalid_license" }, 404);

  const deviceHash = await hashDeviceId(deviceId, env);
  const activation = (license.activations || []).find(
    (item) => item.device_hash === deviceHash
  );

  if (activation) {
    activation.status = "deactivated";
    activation.deactivated_at = new Date().toISOString();
    license.updated_at = activation.deactivated_at;
    await storeLicense(license, env);
  }

  return json({ ok: true, license: publicLicenseResponse(license) });
}

async function handleAdminLicense(request, env, url) {
  const authResult = isAdminAuthorized(request, env);
  if (!authResult.ok) return json({ ok: false, error: authResult.error }, authResult.status);

  const kvError = ensureKv(env);
  if (kvError) return kvError;

  if (request.method === "POST" && url.pathname === "/admin/license/email") {
    const body = await readJson(request);
    if (!body) return json({ ok: false, error: "invalid_json" }, 400);

    const license = await findLicenseFromAdminBody(body, env);
    if (!license) return json({ ok: false, error: "license_not_found" }, 404);

    const email = normalizeEmail(body.email || body.customer_email || body.customerEmail);
    if (email && email !== license.customer_email) {
      license.customer_email = email;
      license.updated_at = new Date().toISOString();
      await storeLicense(license, env);
      await storeLicenseIndexes(license, env);
    }

    const emailResult = await maybeSendLicenseEmail(license, env, {
      force: body.force !== false,
    });

    return json(
      { ok: emailResult.ok, email: emailResult, license },
      emailResult.ok ? 200 : emailResult.statusCode || 500
    );
  }

  if (request.method === "GET") {
    const license = await findLicenseFromAdminQuery(url.searchParams, env);
    if (!license) return json({ ok: false, error: "license_not_found" }, 404);
    return json({ ok: true, license });
  }

  if (request.method === "POST" && url.pathname === "/admin/licenses") {
    const body = await readJson(request);
    if (!body) return json({ ok: false, error: "invalid_json" }, 400);

    const existing = await findLicenseFromAdminBody(body, env);
    if (existing) return json({ ok: true, duplicate: true, license: existing });

    const now = new Date().toISOString();
    const license = createLicenseRecord({
      source: "admin",
      status: body.status || "active",
      plan: body.plan || "unknown",
      customerId: body.customer_id || body.customerId,
      customerEmail: body.email || body.customer_email || body.customerEmail,
      subscriptionId: body.subscription_id || body.subscriptionId,
      transactionId: body.transaction_id || body.transactionId,
      priceIds: body.price_ids || body.priceIds || [],
      currentPeriodEndsAt: body.current_period_ends_at || body.currentPeriodEndsAt,
      env,
      now,
    });

    await storeLicense(license, env);
    await storeLicenseIndexes(license, env);
    await maybeSendLicenseEmail(license, env);

    return json({ ok: true, license });
  }

  return json({ ok: false, error: "method_not_allowed" }, 405, {
    allow: "GET, POST",
  });
}

async function findLicenseFromAdminQuery(params, env) {
  const licenseKey = params.get("license_key") || params.get("licenseKey");
  if (licenseKey) return getLicenseByKey(licenseKey, env);

  const subscriptionId = params.get("subscription_id") || params.get("subscriptionId");
  if (subscriptionId) return getLicenseByIndex(`license_by_subscription:${subscriptionId}`, env);

  const transactionId = params.get("transaction_id") || params.get("transactionId");
  if (transactionId) return getLicenseByIndex(`license_by_transaction:${transactionId}`, env);

  const customerId = params.get("customer_id") || params.get("customerId");
  if (customerId) return getLicenseByIndex(`license_by_customer:${customerId}`, env);

  const email = normalizeEmail(params.get("email"));
  if (email) return getLicenseByIndex(`license_by_email:${email}`, env);

  return null;
}

async function findLicenseFromAdminBody(body, env) {
  if (body.license_key || body.licenseKey) {
    const license = await getLicenseByKey(body.license_key || body.licenseKey, env);
    if (license) return license;
  }

  const subscriptionId = body.subscription_id || body.subscriptionId;
  if (subscriptionId) {
    const license = await getLicenseByIndex(`license_by_subscription:${subscriptionId}`, env);
    if (license) return license;
  }

  const transactionId = body.transaction_id || body.transactionId;
  if (transactionId) {
    const license = await getLicenseByIndex(`license_by_transaction:${transactionId}`, env);
    if (license) return license;
  }

  const customerId = body.customer_id || body.customerId;
  if (customerId) {
    const license = await getLicenseByIndex(`license_by_customer:${customerId}`, env);
    if (license) return license;
  }

  const email = normalizeEmail(body.email || body.customer_email || body.customerEmail);
  if (email) {
    const license = await getLicenseByIndex(`license_by_email:${email}`, env);
    if (license) return license;
  }

  return null;
}

async function getLicenseByIndex(indexKey, env) {
  const licenseKey = await env.PADDLE_EVENTS.get(indexKey);
  return licenseKey ? getLicenseByKey(licenseKey, env) : null;
}

async function getLicenseByKey(licenseKey, env) {
  const normalized = normalizeLicenseKey(licenseKey);
  if (!normalized) return null;

  const license = await env.PADDLE_EVENTS.get(`license:${normalized}`, "json");
  return license || null;
}

async function storeLicense(license, env) {
  const normalized = normalizeLicenseKey(license.license_key);
  license.license_key = normalized;
  await env.PADDLE_EVENTS.put(`license:${normalized}`, JSON.stringify(license));
}

async function storeLicenseIndexes(license, env) {
  const normalized = normalizeLicenseKey(license.license_key);

  if (license.subscription_id) {
    await env.PADDLE_EVENTS.put(`license_by_subscription:${license.subscription_id}`, normalized);
  }

  if (license.transaction_id) {
    await env.PADDLE_EVENTS.put(`license_by_transaction:${license.transaction_id}`, normalized);
  }

  if (license.customer_id) {
    await env.PADDLE_EVENTS.put(`license_by_customer:${license.customer_id}`, normalized);
  }

  const email = normalizeEmail(license.customer_email);
  if (email) {
    await env.PADDLE_EVENTS.put(`license_by_email:${email}`, normalized);
  }
}

async function maybeSendLicenseEmail(license, env, options = {}) {
  if (license.email_sent_at && !options.force) {
    return { ok: true, skipped: true, status: "email_already_sent" };
  }

  if (!license.customer_email) {
    license.fulfillment_status = "missing_customer_email";
    license.updated_at = new Date().toISOString();
    await storeLicense(license, env);
    return { ok: false, error: "missing_customer_email", statusCode: 400 };
  }

  if (!env.RESEND_API_KEY) {
    license.fulfillment_status = "email_not_configured";
    license.updated_at = new Date().toISOString();
    await storeLicense(license, env);
    return { ok: false, error: "email_not_configured", statusCode: 500 };
  }

  if (!env.LICENSE_EMAIL_FROM) {
    license.fulfillment_status = "missing_license_email_from";
    license.updated_at = new Date().toISOString();
    await storeLicense(license, env);
    return { ok: false, error: "missing_license_email_from", statusCode: 500 };
  }

  const downloadUrl = env.MAC_KIT_DOWNLOAD_URL || "https://mackit.rojhot.com";
  const emailPayload = {
    from: env.LICENSE_EMAIL_FROM,
    to: [license.customer_email],
    subject: "Your Mac Kit license",
    html: licenseEmailHtml(license, downloadUrl),
    text: licenseEmailText(license, downloadUrl),
  };

  if (env.LICENSE_EMAIL_REPLY_TO) {
    emailPayload.reply_to = env.LICENSE_EMAIL_REPLY_TO;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(emailPayload),
  });

  const responseText = await response.text();
  const now = new Date().toISOString();

  if (!response.ok) {
    license.fulfillment_status = "email_failed";
    license.fulfillment_error = responseText.slice(0, 500);
    license.updated_at = now;
    await storeLicense(license, env);
    return {
      ok: false,
      error: "email_failed",
      provider_status: response.status,
      provider_response: license.fulfillment_error,
      statusCode: 502,
    };
  }

  let emailResponse = {};
  try {
    emailResponse = JSON.parse(responseText);
  } catch {
    emailResponse = {};
  }

  license.fulfillment_status = "email_sent";
  license.email_sent_at = now;
  license.email_last_sent_to = license.customer_email;
  license.email_send_count = Number(license.email_send_count || 0) + 1;
  license.email_provider_id = emailResponse.id || null;
  delete license.fulfillment_error;
  license.updated_at = now;
  await storeLicense(license, env);

  return {
    ok: true,
    status: "email_sent",
    provider_id: license.email_provider_id,
    sent_to: license.email_last_sent_to,
  };
}

function licenseEmailHtml(license, downloadUrl) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
      <h1>Your Mac Kit license</h1>
      <p>Thanks for buying Mac Kit. Use this license key to activate the app:</p>
      <p style="font-size:20px;font-weight:700;letter-spacing:0.04em">${escapeHtml(license.license_key)}</p>
      <p>Download Mac Kit here: <a href="${escapeHtml(downloadUrl)}">${escapeHtml(downloadUrl)}</a></p>
      <p>If you need help, reply to this email.</p>
    </div>
  `;
}

function licenseEmailText(license, downloadUrl) {
  return [
    "Your Mac Kit license",
    "",
    "Thanks for buying Mac Kit. Use this license key to activate the app:",
    license.license_key,
    "",
    `Download Mac Kit here: ${downloadUrl}`,
  ].join("\n");
}

async function resolveCustomerEmail(entity, env) {
  const directEmail = extractCustomerEmail(entity);
  if (directEmail) return normalizeEmail(directEmail);

  const customerId = entity.customer_id || entity.customer?.id;
  if (!customerId || !env.PADDLE_API_KEY) return null;

  const baseUrl =
    env.PADDLE_ENVIRONMENT === "sandbox"
      ? "https://sandbox-api.paddle.com"
      : "https://api.paddle.com";

  const response = await fetch(`${baseUrl}/customers/${customerId}`, {
    headers: {
      authorization: `Bearer ${env.PADDLE_API_KEY}`,
      accept: "application/json",
    },
  });

  if (!response.ok) return null;

  const payload = await response.json();
  return normalizeEmail(payload?.data?.email);
}

function extractCustomerEmail(entity) {
  return (
    entity.customer_email ||
    entity.email ||
    entity.customer?.email ||
    entity.customer?.email_address ||
    entity.customer_details?.email ||
    entity.billing_details?.email ||
    entity.custom_data?.email ||
    null
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

function mapSubscriptionStatus(status, eventType) {
  if (eventType === "subscription.canceled") return "canceled";
  if (eventType === "subscription.paused") return "paused";
  if (eventType === "subscription.past_due") return "past_due";
  if (eventType === "subscription.resumed") return "active";

  if (status === "active" || status === "trialing") return status;
  if (status === "paused") return "paused";
  if (status === "past_due") return "past_due";
  if (status === "canceled") return "canceled";
  return status || "unknown";
}

function getSubscriptionPeriodEnd(entity) {
  return (
    entity.current_billing_period?.ends_at ||
    entity.billing_period?.ends_at ||
    entity.next_billed_at ||
    entity.scheduled_change?.effective_at ||
    null
  );
}

function isLicenseUsable(license) {
  return activeLicenseStatuses.has(license.status);
}

function publicLicenseResponse(license) {
  const activations = Array.isArray(license.activations) ? license.activations : [];

  return {
    status: license.status || "unknown",
    plan: license.plan || "unknown",
    subscription_id: license.subscription_id || null,
    current_period_ends_at: license.current_period_ends_at || null,
    activation_limit: Number(license.activation_limit || 3),
    activations_used: activations.filter((activation) => activation.status === "active").length,
    fulfillment_status: license.fulfillment_status || null,
  };
}

function isAdminAuthorized(request, env) {
  if (!env.ADMIN_API_KEY) {
    return { ok: false, status: 500, error: "missing_admin_api_key" };
  }

  const header = request.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token || token !== env.ADMIN_API_KEY) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  return { ok: true };
}

function generateLicenseKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const body = [...bytes]
    .map((byte) => licenseAlphabet[byte % licenseAlphabet.length])
    .join("");

  return formatLicenseKey(body);
}

function normalizeLicenseKey(value) {
  if (!value) return null;

  const compact = String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = compact.startsWith(licensePrefix)
    ? compact.slice(licensePrefix.length)
    : compact;

  if (body.length < 12) return null;
  return formatLicenseKey(body.slice(0, 16));
}

function formatLicenseKey(body) {
  const groups = body.match(/.{1,4}/g) || [];
  return `${licensePrefix}-${groups.join("-")}`;
}

function normalizeEmail(value) {
  if (!value) return null;
  const email = String(value).trim().toLowerCase();
  return email.includes("@") ? email : null;
}

function sanitizeString(value, maxLength) {
  if (!value) return null;
  return String(value).trim().slice(0, maxLength);
}

async function hashDeviceId(deviceId, env) {
  const salt = env.LICENSE_DEVICE_SALT || "mac-kit-license-device";
  return sha256Hex(`${salt}:${deviceId}`);
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

  return hexFromArrayBuffer(signature);
}

async function sha256Hex(payload) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(payload));
  return hexFromArrayBuffer(digest);
}

function hexFromArrayBuffer(buffer) {
  return [...new Uint8Array(buffer)]
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

function ensureKv(env) {
  if (!env.PADDLE_EVENTS) {
    return json({ ok: false, error: "missing_paddle_events_kv" }, 500);
  }

  return null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...jsonHeaders,
      ...corsHeaders,
      ...headers,
    },
  });
}
