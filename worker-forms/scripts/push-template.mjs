// Pushes templates/handoff.{html,txt} to Resend and publishes it.
//
// The dashboard is the source of truth once the template is live: editing it
// there and publishing is the whole point of using stored templates. Running
// this script overwrites those edits, so it is for the first upload or for
// deliberately restoring the version kept in this repo.
//
//   RESEND_API_KEY=re_... node worker-forms/scripts/push-template.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.error("RESEND_API_KEY is not set.");
  process.exit(1);
}

const alias = "mac-kit-handoff";
const templates = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

const body = {
  name: "Mac Kit handoff",
  alias,
  subject: "Install Mac Kit on your Mac",
  html: await readFile(join(templates, "handoff.html"), "utf8"),
  text: await readFile(join(templates, "handoff.txt"), "utf8"),
  variables: [
    { key: "SITE_URL", type: "string", fallback_value: "https://usemackit.com" },
    {
      key: "DOWNLOAD_URL",
      type: "string",
      fallback_value: "https://github.com/mahsumozer/mac-kit-releases/releases/latest",
    },
  ],
};

async function call(method, path, payload) {
  const response = await fetch(`https://api.resend.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "user-agent": "mac-kit-forms",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { status: response.status, body: await response.text() };
}

let result = await call("PATCH", `/templates/${alias}`, body);
if (result.status === 404) {
  result = await call("POST", "/templates", body);
}
if (result.status >= 300) {
  console.error("Upload failed:", result.status, result.body);
  process.exit(1);
}
console.log("Uploaded:", result.body);

const published = await call("POST", `/templates/${alias}/publish`);
if (published.status >= 300) {
  console.error("Publish failed:", published.status, published.body);
  process.exit(1);
}
console.log("Published:", published.body);
