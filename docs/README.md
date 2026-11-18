# Transcript Dock API reference (compact)

A one page summary of the public `/v1` API. The full reference is at [transcriptdock.com/docs/api-reference](https://www.transcriptdock.com/docs/api-reference) and the machine readable contract is the [OpenAPI 3.1 spec](https://www.transcriptdock.com/docs/openapi.yaml) ([repo](https://github.com/TranscriptDock/transcriptdock-openapi)).

## Basics

| | |
|---|---|
| Base URL | `https://www.transcriptdock.com` (always `www`; the apex redirects and clients drop `Authorization` on that redirect) |
| Auth | `Authorization: Bearer td_live_...`, created in the [dashboard](https://www.transcriptdock.com/dashboard) |
| Key scopes | `jobs:read`, `jobs:write`, `transcripts:read`, `uploads:write` |
| Format | JSON in and out. Unknown fields are rejected with `422`. |
| Times | Timestamps are UTC RFC 3339. Transcript `start` and `end` are seconds. |
| Ids | UUIDs, except platform media ids |
| Request id | Every response has `X-Request-Id`. Quote it to support. |

## Idempotency

`Idempotency-Key` (8 to 128 printable ASCII characters) is required on:

- `POST /v1/jobs`
- `POST /v1/batches`
- `POST /v1/jobs/{id}/retry`
- `POST /v1/video-discoveries`
- `POST /v1/language-discoveries`

Same key and same body returns the original object at no cost. Same key with a different body is `409 IDEMPOTENCY_CONFLICT`.

## Jobs

`POST /v1/jobs`

| Field | Type | Notes |
|---|---|---|
| `source.url` | string | YouTube, TikTok or Instagram link, or any https media link. One of `url` or `upload_id`. |
| `source.upload_id` | uuid | From `POST /v1/uploads`, after the upload is complete |
| `mode` | `captions_only`, `auto`, `transcribe` | Required |
| `caption_languages` | string[] | Up to 5 BCP 47 codes in order of preference. Caption modes only. |
| `caption_preference` | `prefer_creator` (default), `creator_only`, `automatic_only` | Which caption kind to accept |
| `language` | string or null | Spoken language hint for AI transcription. Not a translation target. |
| `recognition_profile` | `standard` | AI transcription only |
| `max_credits` | integer | Spend cap for AI transcription. Default covers 2 hours. Ignored for `captions_only`. |
| `webhook_endpoint_id` | uuid or null | Receives `job.succeeded` or `job.failed` |
| `metadata` | object | Up to 10 string values. Keys up to 64 characters, values up to 256. Echoed in webhooks. |

Responses: `202` with a queued job, or `200` with a finished job when the workspace already holds the same result (`billing.kind: "cached"`, free).

**Job object:** `id`, `status` (`queued`, `processing`, `awaiting_provider`, `succeeded`, `failed`, `cancelled`), `stage` (`resolve`, `captions`, `acquire_audio`, `submit_asr`, `wait_asr`, `finalize`, or null once final), `result_id`, `error`, `billing` (`credits_reserved`, `credits_charged`, `kind`: `captions`, `ai_transcription` or `cached`), `source`, `options`, `created_at`.

| Call | Notes |
|---|---|
| `GET /v1/jobs/{id}?wait=25` | Long poll up to 25 seconds. Returns as soon as the job is final. Add `seen_status` and `seen_stage` to also return on progress. |
| `GET /v1/jobs?limit=20&cursor=` | Newest first, limit 1 to 100. Add `platform` and `source_id` together to see jobs for one video. |
| `POST /v1/jobs/{id}/cancel` | Before AI transcription starts. Later it is `409 CANCELLATION_NOT_ALLOWED`. |
| `POST /v1/jobs/{id}/retry` | Only when `error.retryable` was true. New idempotency key, optional `{ "max_credits": n }`. |

## Transcripts

`GET /v1/transcripts/{id}` returns `id`, `source`, `source_origin` (`creator_captions`, `platform_captions`, `speech_recognition`), `language`, `text`, `segments` (`start`, `end`, `text`), `words` (`start`, `end`, `text`, `confidence`, or null), `timing_granularity` (`word`, `segment`, `none`), `duration_seconds`, `recognition` (AI only: `profile`, `model`, `quality_status`), `extraction_version`, `created_at`.

`GET /v1/transcripts/{id}/export?format=txt|json|srt|vtt` returns a file. `srt` and `vtt` need timing, otherwise `422 TIMESTAMPS_UNAVAILABLE`.

`DELETE /v1/transcripts/{id}` hides the transcript at once and schedules the purge.

Retention: 7 days on the free plan, 30 on Starter, 90 on Pro and Scale.

## Batches

`POST /v1/batches` with `items` (1 to your plan limit of job bodies), optional `webhook_endpoint_id` and `metadata`. The whole batch is accepted or rejected together. Items per batch: 1 free, 10 Starter, 25 Pro, 50 Scale.

`GET /v1/batches/{id}` returns `status` (`queued`, `processing`, `succeeded`, `partial_success`, `failed`, `cancelled`), `total_items`, `succeeded_items`, `failed_items`, `cancelled_items`, `child_job_ids` and `items` (`job_id`, `item_index`, `status`).

## Uploads

1. `POST /v1/uploads` with `filename`, `content_type`, `bytes` (up to 262,144,000). Returns `id` and `signed_upload_url`, valid for 24 hours.
2. `PUT` the bytes to `signed_upload_url` with the same `Content-Type`. Do not send your API key there.
3. `POST /v1/uploads/{id}/complete`.
4. `POST /v1/jobs` with `source.upload_id` and `mode` `auto` or `transcribe`.

## Discovery

`POST /v1/video-discoveries`, then `GET /v1/video-discoveries/{id}` until `status` is `succeeded` or `failed`. 1 credit per page. Results are kept for 24 hours.

| `kind` | Fields |
|---|---|
| `youtube_search` | `query` |
| `youtube_channel_videos` | `channel` |
| `youtube_channel_search` | `channel`, `query` |
| `youtube_playlist_videos` | `playlist` |
| `tiktok_user_videos` | `user`, optional `include_details`. At most 10 videos, no next page. |

`limit` 1 to 50 (default 20). Pass `next_cursor` back as `cursor` for the next YouTube page.

`POST /v1/language-discoveries` with `{ "source": { "url": "..." } }` lists a YouTube video's caption tracks. 1 credit.

## Account

- `GET /v1/capabilities`: public without a key; plan aware with one.
- `GET /v1/usage`: `plan`, `credits_remaining`, `credits_total`, `credits_reserved`, `prepaid_credits`, `period_end`, `subscription`.
- `GET /v1/webhook-endpoints`: list endpoints. Creating and disabling them needs a signed in dashboard session.

## Webhooks

Events `job.succeeded`, `job.failed`, `batch.completed`. Headers `X-TranscriptDock-Event-Id`, `X-TranscriptDock-Timestamp`, `X-TranscriptDock-Signature`. The signature is a hex HMAC SHA256 of `{event_id}.{timestamp}.{raw_body}` with the endpoint secret. Reject timestamps older than five minutes, compare in constant time, answer 2xx quickly and deduplicate on `event_id`. Python version of the check:

```python
import hashlib
import hmac
import time

def verify(event_id: str, timestamp: str, raw_body: bytes, signature: str, secret: str) -> bool:
    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > 300:
        return False
    message = f"{event_id}.{timestamp}.".encode() + raw_body
    expected = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

## Rate limits

| Plan | Submits a minute | Jobs in progress | Reads a minute |
|---|---|---|---|
| Free | 10 | 10 | 120 |
| Starter | 60 | 100 | 120 |
| Pro | 120 | 500 | 120 |
| Scale | 300 | 2,000 | 120 |

Over a limit you get `429 RATE_LIMITED` with `Retry-After`. Nothing is charged.

## Limits

2 hours of media and 250 MB per source. Exports: `txt`, `json`, `srt`, `vtt`. Public media only.
