// Upload a local audio or video file and transcribe it with a spend cap.
//
// Cost: AI transcription, 2 credits per started minute with a 60 second minimum.
//       MAX_CREDITS (default 20) caps it: 20 credits covers up to 10 minutes. Longer
//       media fails with BUDGET_EXCEEDED before anything is charged. Paid plans only.
// Files: mp3, wav, m4a, ogg, aac, mp4 or webm, up to 250 MB and 2 hours.
// Run:  TRANSCRIPTDOCK_API_KEY=td_live_... node upload.mjs FILE CONTENT_TYPE [MAX_CREDITS]
//       e.g. node upload.mjs interview.mp3 audio/mpeg 20
// Node 18 or newer. No dependencies.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

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

async function waitForJob(id, timeoutMs = 30 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await api("GET", `/v1/jobs/${id}?wait=25`);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`Job ${id} is still ${job.status}. Check it again later.`);
    await sleep(1000);
  }
}

const [file, contentType, maxArg] = process.argv.slice(2);
if (!file || !contentType) {
  console.error("Usage: node upload.mjs FILE CONTENT_TYPE [MAX_CREDITS]");
  process.exit(2);
}
const maxCredits = Number.parseInt(maxArg ?? "20", 10);
if (!Number.isInteger(maxCredits) || maxCredits < 1) throw new Error("MAX_CREDITS must be a positive whole number.");

const bytes = await readFile(file);

// 1. Reserve a slot. The signed URL is valid for 24 hours.
const upload = await api("POST", "/v1/uploads", {
  body: { filename: basename(file), content_type: contentType, bytes: bytes.length },
});

// 2. PUT the bytes to the signed URL with the same Content-Type.
//    Do NOT send your Transcript Dock API key to the storage host.
const put = await fetch(upload.signed_upload_url, {
  method: "PUT",
  headers: { "Content-Type": contentType },
  body: bytes,
});
if (!put.ok) throw new Error(`Upload failed with HTTP ${put.status}`);

// 3. Mark the upload complete. It is now ready to use as a job source.
await api("POST", `/v1/uploads/${upload.id}/complete`);

// 4. Transcribe it. Uploads always use AI transcription.
const idempotencyKey = randomUUID();
console.error(`Idempotency-Key: ${idempotencyKey}`);
const created = await api("POST", "/v1/jobs", {
  idempotencyKey,
  body: { source: { upload_id: upload.id }, mode: "transcribe", max_credits: maxCredits },
});

const job = await waitForJob(created.id);
if (job.status !== "succeeded") {
  console.error(`Job ${job.status}: ${job.error?.code} ${job.error?.message ?? ""}`);
  process.exit(1);
}

const transcript = await api("GET", `/v1/transcripts/${job.result_id}`);
console.error(
  `${transcript.duration_seconds ?? "?"} s of media, ${transcript.words?.length ?? 0} words,` +
    ` ${job.billing.credits_charged} credits charged`,
);
console.log(await api("GET", `/v1/transcripts/${job.result_id}/export?format=vtt`, { text: true }));
