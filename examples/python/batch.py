"""Submit several links in one batch, wait for it, then print each transcript.

Cost: 1 credit per item that has captions (captions_only). Items without captions fail for free.
Plan: items per batch are 1 on the free plan, 10 on Starter, 25 on Pro, 50 on Scale.
Setup: python -m pip install transcriptdock
Run:   TRANSCRIPTDOCK_API_KEY=td_live_... python batch.py [URL ...]
"""

import os
import sys
import time
from uuid import uuid4

from transcriptdock import TranscriptDock

urls = sys.argv[1:] or [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.tiktok.com/@tiktok/video/7680721699171601694",
]

client = TranscriptDock(os.environ["TRANSCRIPTDOCK_API_KEY"])

# One key for the whole batch. Save it: resending the same body with it
# returns the original batch instead of creating a second one.
batch_key = str(uuid4())
print("Idempotency-Key:", batch_key, file=sys.stderr)

batch = client.create_batch(
    {"items": [{"source": {"url": u}, "mode": "captions_only", "max_credits": 1} for u in urls],
     "metadata": {"example": "batch.py"}},
    idempotency_key=batch_key,
)
print("Batch", batch["id"], "with", batch["total_items"], "item(s)", file=sys.stderr)

# Batches have no long poll. Read every few seconds, or register a webhook instead.
deadline = time.monotonic() + 15 * 60
while batch["status"] not in ("succeeded", "partial_success", "failed", "cancelled"):
    if time.monotonic() > deadline:
        sys.exit(f"Batch {batch['id']} is still {batch['status']}. Check it again later.")
    time.sleep(5)
    batch = client.get_batch(batch["id"])
    print(batch["status"], batch["succeeded_items"], "ok,", batch["failed_items"], "failed", file=sys.stderr)

# Every item is a normal job.
for item in batch["items"]:
    job = client.get_job(item["job_id"])
    print(f"\n# {urls[item['item_index']]}")
    if job["status"] != "succeeded":
        print(job["status"], (job.get("error") or {}).get("code"))
        continue
    text = client.export_transcript(job["result_id"], "txt")
    print(text[:500] + ("..." if len(text) > 500 else ""))
