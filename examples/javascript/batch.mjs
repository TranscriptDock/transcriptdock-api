// Submit a YouTube and a TikTok link in one batch, wait for it, then print each transcript.
//
// Cost: 1 credit per item that has captions (captions_only). Items without captions fail for free.
// Plan: items per batch are 1 on the free plan, 10 on Starter, 25 on Pro, 50 on Scale.
// Run:  TRANSCRIPTDOCK_API_KEY=td_live_... node batch.mjs [URL ...]
// Node 18 or newer. No dependencies.

import { randomUUID } from "node:crypto";

const API = "https://www.transcriptdock.com";
const KEY = process.env.TRANSCRIPTDOCK_API_KEY;
if (!KEY) {
  console.error("Set TRANSCRIPTDOCK_API_KEY to your td_live_ key.");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, path, { body, idempotencyKey, text = false } = {}) {
  const headers = { Authorization: `Bearer ${KEY}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      `${res.status} ${data.error?.code ?? "HTTP_ERROR"}: ${data.error?.message ?? res.statusText}` +
        ` (request ${data.request_id ?? res.headers.get("x-request-id")})`,
    );
  }
  return text ? res.text() : res.json();
}

const urls = process.argv.slice(2);
if (urls.length === 0) {
  urls.push(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.tiktok.com/@tiktok/video/7680721699171601694",
  );
}

// One key for the whole batch. Child jobs derive their own keys from it.
const idempotencyKey = randomUUID();
console.error(`Idempotency-Key: ${idempotencyKey}`);

let batch = await api("POST", "/v1/batches", {
  idempotencyKey,
  body: {
    items: urls.map((url) => ({ source: { url }, mode: "captions_only", max_credits: 1 })),
    metadata: { example: "batch.mjs" },
  },
});
console.error(`Batch ${batch.id}: ${batch.total_items} item(s)`);

// Batches have no long poll, so read every few seconds. A webhook avoids polling.
const finished = new Set(["succeeded", "partial_success", "failed", "cancelled"]);
const deadline = Date.now() + 15 * 60_000;
while (!finished.has(batch.status)) {
  if (Date.now() > deadline) throw new Error(`Batch ${batch.id} is still ${batch.status}. Check it again later.`);
  await sleep(5000);
  batch = await api("GET", `/v1/batches/${batch.id}`);
  console.error(`${batch.status}: ${batch.succeeded_items} ok, ${batch.failed_items} failed`);
}

// Every item is a normal job. Read it for result_id or error.
for (const item of batch.items) {
  const job = await api("GET", `/v1/jobs/${item.job_id}`);
  const url = urls[item.item_index];
  if (job.status !== "succeeded") {
    console.log(`\n# ${url}\n${job.status}: ${job.error?.code ?? ""}`);
    continue;
  }
  const text = await api("GET", `/v1/transcripts/${job.result_id}/export?format=txt`, { text: true });
  console.log(`\n# ${url}\n${text.slice(0, 500)}${text.length > 500 ? "..." : ""}`);
}
