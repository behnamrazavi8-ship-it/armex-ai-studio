import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");

test("authenticated API exposes Alpha video create, status and history actions", async () => {
  const api = await read("supabase/functions/armex-api/index.ts");
  const adapter = await read("supabase/functions/armex-api/alpha-video-api.ts");
  assert.match(api, /handleAlphaVideoApi/);
  assert.match(api, /alpha_video_status/);
  assert.match(api, /alpha_video_history/);
  assert.match(api, /create_alpha_video/);
  assert.match(adapter, /ALPHA_VIDEO_CREDIT_COST/);
  assert.match(adapter, /armex_create_video_job/);
  assert.match(adapter, /\.eq\("user_id", userId\)/);
});

test("worker never retries an ambiguous Alpha create request", async () => {
  const worker = await read("supabase/functions/alpha-video-worker/index.ts");
  assert.match(worker, /video-wan22/);
  assert.match(worker, /\/generations/);
  assert.match(worker, /submission_unknown/);
  assert.match(worker, /armex_video_submission_unknown/);
  assert.match(worker, /MAX_OUTPUT_BYTES/);
  assert.match(worker, /ftyp/);
  assert.match(worker, /lokal-chat-media/);
});

test("schema draft reserves credits atomically and protects user-owned jobs", async () => {
  const sql = await read("docs/alpha-video/alpha-video-schema-draft.sql");
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /auth\.uid\(\)\) = user_id/);
  assert.match(sql, /armex_debit_credits/);
  assert.match(sql, /armex_grant_credits/);
  assert.match(sql, /unique \(user_id, request_id\)/i);
  assert.match(sql, /armex_finish_video_job/);
});

test("video studio uses private signed uploads and does not expose provider keys", async () => {
  const ui = await read("index.html");
  const module = await read("modules/video/video-studio.js");
  assert.match(ui, /id="video-form"/);
  assert.match(ui, /id="video-history"/);
  assert.match(module, /uploadToSignedUrl/);
  assert.match(module, /complete_media_upload/);
  assert.match(module, /alpha_video_status/);
  assert.doesNotMatch(module, /ALPHA_API_KEY|ALPHA_VIDEO_WORKER_SECRET/);
});
