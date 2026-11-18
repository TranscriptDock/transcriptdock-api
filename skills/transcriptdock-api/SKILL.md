---
name: transcriptdock-api
description: Get transcripts from YouTube, TikTok, Instagram Reels, uploaded files or direct media links with the Transcript Dock HTTP API, and export them as TXT, JSON, SRT or VTT. Use when the user asks to transcribe a video or audio file, fetch captions or subtitles, or quote what a video says with timestamps. Spends the user's credits, so follow the cost rules.
---

# Transcript Dock API

Transcript Dock turns a video link or media file into a timed transcript. Every transcript is an asynchronous job: submit, wait, then read or export. Full reference: https://www.transcriptdock.com/docs/api-reference

## When to use

- The user gives a YouTube, TikTok or Instagram link and wants the transcript, captions, subtitles, a summary of what was said, or quotes with times.
- The user has an audio or video file, or an https link to one, and wants it transcribed.
- The user wants SRT or VTT subtitles for a video.

Do not use it for private, members only or age gated videos (they fail), for translation (not offered), or for speaker labels (not offered).

## Setup

- Base URL: `https://www.transcriptdock.com`. Always use `www`: the apex domain redirects and the `Authorization` header is dropped on that redirect.
- Auth header: `Authorization: Bearer $TRANSCRIPTDOCK_API_KEY`. Read the key from the environment. Never print it, log it, put it in a URL or ask the user to paste it into the chat. If it is missing, tell the user to create a key at https://www.transcriptdock.com/dashboard and set `TRANSCRIPTDOCK_API_KEY`.
- Send `Content-Type: application/json` on POST requests.

## Step 1. Check what is possible (free)

```bash
curl -sS https://www.transcriptdock.com/v1/capabilities -H "Authorization: Bearer $TRANSCRIPTDOCK_API_KEY"
curl -sS https://www.transcriptdock.com/v1/usage -H "Authorization: Bearer $TRANSCRIPTDOCK_API_KEY"
```

`capabilities` shows, per source (`youtube`, `tiktok`, `instagram`, `upload`, `direct`), whether `captions_only`, `auto` and `transcribe` are open to this key's plan. `usage` shows `plan` and `credits_remaining`. Do not offer a mode that capabilities reports as false.

## Step 2. Pick the mode and the cost

| Mode | Cost | Use when |
|---|---|---|
| `captions_only` | 1 credit per success, 0 if no captions | YouTube or TikTok. Always try this first. |
| `auto` | 1 credit with captions, else 2 credits per started minute (60 s minimum) | Only after the user agreed to AI transcription cost. Instagram, uploads and direct links need `auto` or `transcribe`. |
| `transcribe` | 2 credits per started minute (60 s minimum) | The user wants word timing, or the captions are poor, and agreed to the cost. |

`auto` and `transcribe` need a paid plan. Instagram has no captions path: `captions_only` returns `CAPABILITY_UNAVAILABLE` for it.

## Step 3. Submit with an idempotency key and a spend cap

```bash
KEY_ID="$(uuidgen 2>/dev/null || date +%s%N)"   # generate ONCE per intended job and remember it
curl -sS -X POST https://www.transcriptdock.com/v1/jobs \
  -H "Authorization: Bearer $TRANSCRIPTDOCK_API_KEY" \
  -H "Idempotency-Key: $KEY_ID" \
  -H "Content-Type: application/json" \
  -d '{"source":{"url":"VIDEO_URL"},"mode":"captions_only","max_credits":1}'
```

Rules:

- `Idempotency-Key` is required (8 to 128 printable ASCII characters). If the response is lost or times out, resend the SAME body with the SAME key. Never retry with a new key: that can create and charge a second job.
- Always send `max_credits`. For AI transcription compute it from the longest media you accept: 2 credits per started minute, so 10 minutes is 20. If the measured cost is higher, the job fails with `BUDGET_EXCEEDED` and nothing is charged.
- A `200` instead of `202` means the workspace already had this result. It is free (`billing.kind: "cached"`).
- Body fields: `source.url` or `source.upload_id`, `mode`, optional `caption_languages` (up to 5 codes in order), `caption_preference` (`prefer_creator`, `creator_only`, `automatic_only`), `language` (spoken language hint for AI only), `max_credits`, `webhook_endpoint_id`, `metadata`. Unknown fields are rejected.

## Step 4. Wait (free)

```bash
curl -sS "https://www.transcriptdock.com/v1/jobs/JOB_ID?wait=25" -H "Authorization: Bearer $TRANSCRIPTDOCK_API_KEY"
```

`wait=25` holds the request until the job is final or 25 seconds pass. Repeat until `status` is `succeeded`, `failed` or `cancelled`. Stop after a sensible total (for example 10 minutes for AI jobs) and tell the user the job id so they can check later. AI transcription takes roughly a quarter of the media length. Do not poll in a tight loop: reads are limited to 120 a minute.

## Step 5. Read or export (free)

```bash
curl -sS https://www.transcriptdock.com/v1/transcripts/RESULT_ID -H "Authorization: Bearer $TRANSCRIPTDOCK_API_KEY"
curl -sS "https://www.transcriptdock.com/v1/transcripts/RESULT_ID/export?format=srt" -H "Authorization: Bearer $TRANSCRIPTDOCK_API_KEY"
```

`RESULT_ID` is the job's `result_id`. The transcript has `text`, `segments` (`start`, `end` in seconds, `text`), `words` (AI transcription only, with `confidence`), `timing_granularity` (`word`, `segment` or `none`), `source_origin` and `language`. Export formats: `txt`, `json`, `srt`, `vtt`. Exports and reads can be repeated at no cost.

## When there are no captions

If a `captions_only` job fails with `NO_CAPTIONS`, nothing was charged. STOP and ask the user before running AI transcription. Say:

- AI transcription costs 2 credits per started minute, minimum 2 credits.
- An estimate when you know the length (for example, a 12 minute video costs 24 credits).
- That it needs a paid plan.

Only on a clear yes, submit a NEW job with `mode: "auto"` or `"transcribe"`, a NEW idempotency key and a `max_credits` that matches the estimate.

## Errors

The body is `{"error":{"code","message","retryable","retry_after_seconds"?},"request_id"}`. A job that failed after acceptance has `status: "failed"` and the same `error` object.

| Code | What to do |
|---|---|
| `NO_CAPTIONS` | Ask before AI transcription (see above). |
| `PLAN_REQUIRED` | Tell the user this needs a paid plan: https://www.transcriptdock.com/pricing |
| `INSUFFICIENT_BALANCE` | Tell the user they are out of credits. Do not retry. |
| `BUDGET_EXCEEDED` | The media costs more than `max_credits`. Nothing was charged. Ask before raising the cap. |
| `CAPABILITY_UNAVAILABLE` | That mode is not available for this source. Check capabilities. |
| `SOURCE_PRIVATE`, `SOURCE_NOT_FOUND`, `SOURCE_AUTH_REQUIRED`, `SOURCE_REGION_RESTRICTED` | The media is not publicly reachable. Tell the user. Do not try to bypass it. |
| `LANGUAGE_UNAVAILABLE` | None of `caption_languages` exists. Retry without the list, or run a language discovery for YouTube. |
| `IDEMPOTENCY_CONFLICT` | The key was used with a different body. Use a new key only for a genuinely new request. |
| `RATE_LIMITED` | Wait `retry_after_seconds` (or the `Retry-After` header), then resend with the same key. |
| `UNAUTHENTICATED`, `FORBIDDEN` | The key is missing, wrong or lacks a scope. Tell the user. |
| Anything with `retryable: true` | Back off, then resend with the same idempotency key, at most a few times. |
| Anything with `retryable: false` | Do not retry unchanged. Explain the error and quote the `request_id`. |

## Never invent timestamps

- Quote times only from `segments[].start` and `segments[].end` (or `words[]`) in the transcript you fetched. They are seconds: 75.4 is 1:15.
- If `timing_granularity` is `none`, say there is no timing. Do not guess one.
- Caption timing is per cue, not per word. Do not present it as word level.
- Quote text exactly as it appears in `text` or `segments`. If something is not in the transcript, say so.

## More

- Many links at once: `POST /v1/batches` with `items` (each a job body). Items per batch: 1 free, 10 Starter, 25 Pro, 50 Scale.
- Find videos: `POST /v1/video-discoveries` with `kind` `youtube_search`, `youtube_channel_videos`, `youtube_channel_search`, `youtube_playlist_videos` or `tiktok_user_videos`, 1 credit per page, then `GET /v1/video-discoveries/{id}`.
- Your own files: `POST /v1/uploads`, PUT the bytes to `signed_upload_url` WITHOUT the API key, `POST /v1/uploads/{id}/complete`, then a job with `source.upload_id`.
- OpenAPI: https://www.transcriptdock.com/docs/openapi.yaml
