// A minimal webhook receiver that verifies Transcript Dock signatures.
//
// Cost: none. This file never calls the API.
// Setup: register an https URL on the Webhooks page of the dashboard (it shows the
//        signing secret once), then pass its id as webhook_endpoint_id on jobs or batches.
//        Put this server behind https (a reverse proxy or tunnel) at that URL.
// Run:   TRANSCRIPTDOCK_WEBHOOK_SECRET=... PORT=8787 node webhook-receiver.mjs
// Node 18 or newer. No dependencies.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const SECRET = process.env.TRANSCRIPTDOCK_WEBHOOK_SECRET;
if (!SECRET) {
  console.error("Set TRANSCRIPTDOCK_WEBHOOK_SECRET to your endpoint's signing secret.");
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 8787);
const MAX_BODY_BYTES = 64 * 1024; // events are small: they never carry transcript text

// Signature: hex HMAC SHA256 of "{event_id}.{timestamp}.{raw_body}" with the secret.
// Reject anything more than five minutes from our clock, and compare in constant time.
function verify(eventId, timestamp, rawBody, signature) {
  if (!eventId || !timestamp || !signature) return false;
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", SECRET).update(`${eventId}.${timestamp}.`).update(rawBody).digest("hex");
  const given = Buffer.from(String(signature));
  return given.length === expected.length && timingSafeEqual(Buffer.from(expected), given);
}

// Deliveries can repeat. Use a durable store (a unique key in your database) in production.
const seen = new Set();

createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    const raw = Buffer.concat(chunks); // verify the exact bytes, before JSON parsing
    const eventId = req.headers["x-transcriptdock-event-id"];
    const ok = verify(eventId, req.headers["x-transcriptdock-timestamp"], raw, req.headers["x-transcriptdock-signature"]);
    if (!ok) {
      res.writeHead(401).end();
      return;
    }

    // Answer 2xx quickly, then do the slow work.
    res.writeHead(204).end();
    if (seen.has(eventId)) return;
    seen.add(eventId);

    const event = JSON.parse(raw.toString("utf8"));
    switch (event.type) {
      case "job.succeeded":
        // Fetch or export event.result_id with your API key, e.g.
        // GET /v1/transcripts/{result_id}/export?format=txt
        console.log(`job ${event.job_id} succeeded, transcript ${event.result_id}`, event.metadata);
        break;
      case "job.failed":
        console.log(`job ${event.job_id} failed: ${event.error?.code}`, event.metadata);
        break;
      case "batch.completed":
        // Read GET /v1/batches/{batch_id} for per item results.
        console.log(`batch ${event.batch_id} completed`, event.metadata);
        break;
      default:
        console.log(`ignored event type ${event.type}`);
    }
  });
}).listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
