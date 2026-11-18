"""Submit one link, wait for the job, then print the transcript as SRT.

Cost: captions_only spends at most 1 credit, and nothing if the video has no captions.
Setup: python -m pip install transcriptdock
Run:   TRANSCRIPTDOCK_API_KEY=td_live_... python quickstart.py [VIDEO_URL]
"""

import os
import sys
from uuid import uuid4

from transcriptdock import ApiError, JobTimeoutError, TranscriptDock

url = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

client = TranscriptDock(os.environ["TRANSCRIPTDOCK_API_KEY"])
print(client.capabilities(), file=sys.stderr)

# Generate once per intended operation. Save this key and the returned job ID.
# Reuse the same key and exact body if a submission's response is lost.
submission_key = str(uuid4())
print("Idempotency-Key:", submission_key, file=sys.stderr)

try:
    job = client.create_job(
        {"source": {"url": url}, "mode": "captions_only", "max_credits": 1},
        idempotency_key=submission_key,
    )
    job = client.wait_for_job(job["id"], timeout=120)
except JobTimeoutError as error:
    print("Still running", error.job, file=sys.stderr)
    sys.exit(1)
except ApiError as error:
    # retryable and retry_after_seconds describe the API response.
    print(error.code, error.status, error.request_id, file=sys.stderr)
    sys.exit(1)

if job["status"] != "succeeded":
    print(job["status"], job.get("error"), file=sys.stderr)
    if (job.get("error") or {}).get("code") == "NO_CAPTIONS":
        print("No captions. On a paid plan, mode auto or transcribe runs AI transcription"
              " at 2 credits per started minute.", file=sys.stderr)
    sys.exit(1)

transcript = client.get_transcript(job["result_id"])
print(f"{transcript['source_origin']}, {transcript['language']}, "
      f"{len(transcript['segments'])} segments", file=sys.stderr)
print(client.export_transcript(job["result_id"], "srt"))
