# LOKAL AI — RunPod video worker contract

Status: staged integration contract; no GPU endpoint is invoked by CI.

## Request

The API submits a queue-based RunPod Serverless job using `POST /v2/{endpoint_id}/run`.
The `webhook` property is a top-level sibling of `input`, not part of the model input.

`input` contains:

- `task: "text_to_video"`
- `model: "wan2.2-ti2v-5b"`
- `prompt`, `request_id`, `aspect_ratio`, and `duration_seconds: 5`
- `storage_upload.signed_url`: one job-scoped Supabase Storage signed upload URL
- `storage_upload.apikey` and `storage_upload.authorization`: the public anon key headers only
- `storage_upload.content_type: "video/mp4"`
- `storage_upload.max_bytes: 52428800`

The signed URL is valid for two hours and is scoped to the deterministic object path
`<user_id>/<video_job_id>.mp4` in the private `lokal-ai-videos` bucket. It is an upload capability:
never print it, persist it in worker logs, include it in the output, or expose it to the browser.
The worker never receives `SUPABASE_SERVICE_ROLE_KEY`.

## Worker responsibilities

1. Generate the requested five-second clip with the configured Wan 2.2 TI2V-5B pipeline.
2. Encode a real MP4 (H.264 video, AAC audio when audio is present, `video/mp4` content type).
3. Enforce the 50 MiB limit before upload.
4. Upload the file with HTTP `PUT` to the signed URL, sending the supplied `apikey` and `authorization` headers, `Content-Type: video/mp4`, and `x-upsert: true`.
5. Do not return `COMPLETED` until Storage confirms a successful upload response.
6. Return the metadata below, with the exact deterministic storage path and actual byte count.

## Required RunPod output on COMPLETED

```json
{
  "storage_path": "<user_id>/<video_job_id>.mp4",
  "mime_type": "video/mp4",
  "file_size_bytes": 12345678
}
```

The API independently checks that the object exists in the private bucket and that its MIME type and size match the worker output. A temporary Storage verification error is retriable (HTTP 503); a missing or mismatched object fails the job and enters the existing idempotent refund path.

Provider-supplied public URLs are not accepted as durable results. The API stores only the private object path and issues a one-hour signed download URL after verifying the requesting user owns the job.

## Cost-free verification before GPU enablement

CI tests the output contract, path isolation, MIME type, file-size ceiling, and disposable SQL bucket configuration. It does not call RunPod, allocate a GPU, deploy an Edge Function, or mutate production.

## Release gates

- Add the worker implementation and pinned Python dependencies/container build.
- Build and run the worker's upload contract against a disposable Supabase Storage bucket using a tiny synthetic MP4.
- Verify the webhook and polling paths both converge to the same private object and that signed downloads are owner-gated.
- Only then request approval for a controlled paid RunPod smoke test.
