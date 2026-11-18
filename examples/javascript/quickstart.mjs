// Submit one link, wait for the job with long polling, then export SRT.
//
// Cost: captions_only spends at most 1 credit, and nothing if the video has no captions.
// Run:  TRANSCRIPTDOCK_API_KEY=td_live_... node quickstart.mjs [VIDEO_URL]
// Node 18 or newer. No dependencies.

import { randomUUID } from "node:crypto";

const API = "https://www.transcriptdock.com"; // always www: the apex domain redirects
const KEY = process.env.TRANSCRIPTDOCK_API_KEY;
if (!KEY) {
  console.error("Set TRANSCRIPTDOCK_API_KEY to your td_live_ key.");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One API call. Throws with the error code and request id on 4xx or 5xx.
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
    const error = new Error(
      `${res.status} ${data.error?.code ?? "HTTP_ERROR"}: ${data.error?.message ?? res.statusText}` +
        ` (request ${data.request_id ?? res.headers.get("x-request-id")})`,
    );
    error.code = data.error?.code;
    throw error;
  }
  return text ? res.text() : res.json();
}

// Long poll until the job is final. wait=25 holds each request for up to 25 seconds.
async function waitForJob(id, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await api("GET", `/v1/jobs/${id}?wait=25`);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`Job ${id} is still ${job.status}. Check it again later.`);
    await sleep(1000);
  }
}

const url = process.argv[2] ?? "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

// Generate the key once per intended operation and store it with your own record.
// If the response is lost, resend the SAME body with the SAME key: you get the
// original job back and pay nothing twice.
const idempotencyKey = randomUUID();
console.error(`Idempotency-Key: ${idempotencyKey}`);

const created = await api("POST", "/v1/jobs", {
  idempotencyKey,
  body: {
    source: { url },
    mode: "captions_only", // never starts AI transcription
    max_credits: 1, // ignored for captions_only, kept so a switch to auto stays capped
  },
});
console.error(`Job ${created.id} is ${created.status}`);

const job = await waitForJob(created.id);
if (job.status !== "succeeded") {
  console.error(`Job ${job.status}: ${job.error?.code} ${job.error?.message ?? ""}`);
  if (job.error?.code === "NO_CAPTIONS") {
    console.error("No captions. On a paid plan, mode auto or transcribe runs AI transcription (2 credits a minute).");
  }
  process.exit(1);
}

console.error(`Charged ${job.billing.credits_charged} credit(s), kind ${job.billing.kind}`);
// Exports are free and can be repeated: txt, json, srt or vtt.
console.log(await api("GET", `/v1/transcripts/${job.result_id}/export?format=srt`, { text: true }));
