const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
};

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const DEFAULT_RELEASES_PAGE_URL =
  "https://github.com/mahsumozer/mac-kit-releases/releases/latest";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "mac-kit-forms" });
    }

    if (url.pathname === "/handoff/email") {
      return handleHandoffEmail(request, env);
    }

    if (url.pathname === "/newsletter/subscribe") {
      return handleNewsletterSubscribe(request, env);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
};

async function handleHandoffEmail(request, env) {
  const { failure, email } = await readSubmission(request, env, "handoff");
  if (failure) return failure;

  const from = env.FORM_EMAIL_FROM;
  const templateId = env.HANDOFF_TEMPLATE_ID;
  if (!env.RESEND_API_KEY || !from || !templateId) {
    return json({ ok: false, error: "email_not_configured" }, 500);
  }

  const siteUrl = env.SITE_URL || "https://usemackit.com";
  const response = await resendRequest(env, "https://api.resend.com/emails", {
    from,
    to: [email],
    reply_to: env.FORM_EMAIL_REPLY_TO || undefined,
    template: {
      id: templateId,
      variables: {
        DOWNLOAD_URL: await resolveDownloadUrl(env),
        SITE_URL: `${siteUrl}/?utm_source=handoff&utm_medium=email`,
      },
    },
  });

  if (!response.ok) {
    console.log("handoff email failed", response.status, response.body);
    return json({ ok: false, error: "email_failed" }, 502);
  }

  return json({ ok: true });
}

async function handleNewsletterSubscribe(request, env) {
  const { failure, email } = await readSubmission(request, env, "newsletter");
  if (failure) return failure;

  if (!env.RESEND_API_KEY) {
    return json({ ok: false, error: "email_not_configured" }, 500);
  }

  const response = await resendRequest(env, "https://api.resend.com/contacts", {
    email,
    unsubscribed: false,
  });

  if (!response.ok) {
    console.log("newsletter subscribe failed", response.status, response.body);
    return json({ ok: false, error: "subscribe_failed" }, 502);
  }

  return json({ ok: true });
}

// Runs the checks both endpoints share. Returns either a ready-made response to
// send back, or the address to act on.
async function readSubmission(request, env, bucket) {
  if (request.method !== "POST") {
    return { failure: json({ ok: false, error: "method_not_allowed" }, 405) };
  }

  const body = await readJson(request);
  if (!body) {
    return { failure: json({ ok: false, error: "invalid_json" }, 400) };
  }

  // A filled honeypot means a bot. Answer with the success shape a human gets
  // so it has no signal to retry under a different field name.
  if (String(body.email_address_check || "").trim()) {
    return { failure: json({ ok: true }) };
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return { failure: json({ ok: false, error: "invalid_email" }, 400) };
  }

  if (!(await withinRateLimit(request, env, bucket, email))) {
    return { failure: json({ ok: false, error: "rate_limited" }, 429) };
  }

  return { email };
}

// Limits by sender and by recipient: the first stops one machine hammering the
// endpoint, the second stops a spread-out botnet mailbombing one address.
async function withinRateLimit(request, env, bucket, email) {
  if (!env.FORM_LIMITER) return true;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const results = await Promise.all([
    env.FORM_LIMITER.limit({ key: `${bucket}:from:${ip}` }),
    env.FORM_LIMITER.limit({ key: `${bucket}:to:${email}` }),
  ]);
  return results.every((result) => result.success);
}

async function resendRequest(env, url, payload) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        "user-agent": "mac-kit-forms",
      },
      body: JSON.stringify(payload),
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, body: String(error) };
  }
}

// Turns a GitHub "releases/latest" page URL into that repo's asset download
// base. Returns null for any other kind of URL.
function githubLatestDownloadBase(pageUrl) {
  try {
    const url = new URL(pageUrl);
    if (url.hostname !== "github.com") return null;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases(?:\/|$)/);
    if (!match) return null;
    const [, owner, repo] = match;
    return `https://github.com/${owner}/${repo}/releases/latest/download`;
  } catch {
    return null;
  }
}

// Upgrades the releases page URL to the newest release's direct .dmg so the
// link starts the download immediately. The file name comes from
// electron-builder's latest-mac.yml rather than api.github.com, whose
// unauthenticated rate limit is shared per egress IP and rejects Workers
// traffic often enough to silently downgrade the link to the releases page.
async function resolveDownloadUrl(env) {
  const configured = env.MAC_KIT_DOWNLOAD_URL || DEFAULT_RELEASES_PAGE_URL;
  const downloadBase = githubLatestDownloadBase(configured);
  if (!downloadBase) return configured;
  try {
    const response = await fetch(`${downloadBase}/latest-mac.yml`, {
      headers: { "user-agent": "mac-kit-forms" },
    });
    if (!response.ok) return configured;
    const manifest = await response.text();
    const dmg = manifest.match(/[\w.-]+\.dmg(?![\w.-])/);
    return dmg ? `${downloadBase}/${dmg[0]}` : configured;
  } catch {
    return configured;
  }
}

function normalizeEmail(value) {
  if (!value) return null;
  const email = String(value).trim().toLowerCase();
  if (email.length > 254) return null;
  return emailPattern.test(email) ? email : null;
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...corsHeaders },
  });
}
