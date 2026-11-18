"""Upload a local audio or video file, then transcribe it with a spend cap.

Cost: AI transcription, 2 credits per started minute with a 60 second minimum.
      MAX_CREDITS (default 20) caps it: 20 credits covers up to 10 minutes. Longer
      media fails with BUDGET_EXCEEDED before anything is charged. Paid plans only.
Files: mp3, wav, m4a, ogg, aac, mp4 or webm, up to 250 MB and 2 hours.
Setup: python -m pip install transcriptdock
Run:   TRANSCRIPTDOCK_API_KEY=td_live_... python upload.py FILE CONTENT_TYPE [MAX_CREDITS]
       e.g. python upload.py interview.mp3 audio/mpeg 20
"""

import os
import sys
import urllib.request
from uuid import uuid4

from transcriptdock import JobTimeoutError, TranscriptDock

if len(sys.argv) < 3:
    sys.exit("Usage: python upload.py FILE CONTENT_TYPE [MAX_CREDITS]")
path, content_type = sys.argv[1], sys.argv[2]
max_credits = int(sys.argv[3]) if len(sys.argv) > 3 else 20

client = TranscriptDock(os.environ["TRANSCRIPTDOCK_API_KEY"])

with open(path, "rb") as handle:
    data = handle.read()

# 1. Reserve a slot. The signed URL is valid for 24 hours.
upload = client.create_upload(
    {"filename": os.path.basename(path), "content_type": content_type, "bytes": len(data)}
)

# 2. PUT the bytes to the signed URL with the same Content-Type.
#    Do NOT send your Transcript Dock API key to the storage host.
put = urllib.request.Request(
    upload["signed_upload_url"], data=data, method="PUT", headers={"Content-Type": content_type}
)
with urllib.request.urlopen(put, timeout=600) as response:
    if response.status >= 300:
        sys.exit(f"Upload failed with HTTP {response.status}")

# 3. Mark the upload complete. It is now ready to use as a job source.
client.complete_upload(upload["id"])

# 4. Transcribe it. Uploads always use AI transcription.
submission_key = str(uuid4())
print("Idempotency-Key:", submission_key, file=sys.stderr)
job = client.create_job(
    {"source": {"upload_id": upload["id"]}, "mode": "transcribe", "max_credits": max_credits},
    idempotency_key=submission_key,
)
try:
    job = client.wait_for_job(job["id"], timeout=1800, poll_interval=5)
except JobTimeoutError as error:
    sys.exit(f"Still running: {error.job}")

if job["status"] != "succeeded":
    sys.exit(f"{job['status']}: {job.get('error')}")

transcript = client.get_transcript(job["result_id"])
print(f"{transcript['duration_seconds']} s of media, {len(transcript['words'] or [])} words, "
      f"{job['billing']['credits_charged']} credits charged", file=sys.stderr)
print(client.export_transcript(job["result_id"], "vtt"))
