import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isPublicIpv4 } from "../supabase/functions/alpha-video-worker/ip-safety.mjs";

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
  assert.match(worker, /let postAttempted = false/);
  assert.match(worker, /if \(!postAttempted\)[\s\S]*?markFailed\(db, jobId, "input_signing_failed"\)/);
  assert.match(worker, /Once POST starts[\s\S]*?armex_video_submission_unknown/);
  assert.match(worker, /MAX_OUTPUT_BYTES/);
  assert.match(worker, /ftyp/);
  assert.match(worker, /lokal-chat-media/);
  assert.match(worker, /finalization_unknown/);
  assert.match(worker, /armex_video_generations/);
  assert.match(worker, /reconciled\?\.status === "completed"/);
  assert.match(worker, /if \(finishAttempted\)/);
  assert.match(worker, /parseOutputHosts/);
  assert.match(worker, /required\("ALPHA_OUTPUT_HOSTS"\)/);
  assert.match(worker, /allowedHosts\.has\(host\)/);
  assert.match(worker, /safeOutputUrl\(new URL\(location, url\)\.toString\(\), allowedHosts\)/);
  assert.match(worker, /isIpLiteral/);
  assert.match(worker, /fetchPinnedHttps/);
  assert.match(worker, /download\.status !== 200/);
  assert.match(worker, /contentType !== "video\/mp4" && contentType !== "application\/octet-stream"/);
  const pinned = await read("supabase/functions/alpha-video-worker/pinned-http.ts");
  assert.match(pinned, /Deno\.resolveDns\(host, "A"\)/);
  assert.doesNotMatch(pinned, /Deno\.resolveDns\(host, "AAAA"\)/);
  assert.match(pinned, /Deno\.resolveDns\(host, "A"\)/);
  assert.match(pinned, /isPublicIpv4/);
  assert.match(pinned, /provider_output_dns_not_public_ipv4_only/);
  assert.match(pinned, /Deno\.connect\(\{ hostname: ip, port: 443, transport: "tcp" \}\)/);
  assert.match(pinned, /Deno\.startTls\(tcp, \{ hostname: host \}\)/);
  assert.match(pinned, /provider_output_dns_timeout/);
  assert.match(pinned, /provider_output_connect_timeout/);
  assert.match(pinned, /provider_output_tls_timeout/);
  assert.match(pinned, /8000/);
  assert.match(pinned, /10000/);
  assert.match(pinned, /provider_output_peer_ip_mismatch/);
  assert.match(pinned, /remoteAddr/);
  assert.match(pinned, /contentLength === 0/);
  assert.match(pinned, /Accept-Encoding: identity/);
  assert.match(pinned, /pinned_http_transfer_encoding_unsupported/);
  assert.doesNotMatch(worker, /fetch\(url, \{ redirect: "manual" \}\)/);
});

test("schema draft reserves credits atomically and protects user-owned jobs", async () => {
  const sql = await read("docs/alpha-video/alpha-video-schema-draft.sql");
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on public\.armex_video_generations from anon, authenticated/i);
  assert.match(sql, /armex_debit_credits/);
  assert.match(sql, /armex_grant_credits/);
  assert.match(sql, /unique \(user_id, request_id\)/i);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /conversation_id=p_conversation_id/);
  assert.match(sql, /armex_finish_video_job/);
  assert.match(sql, /p_storage_path is null or p_size_bytes is null or p_sha256 is null/i);
  assert.match(sql, /if p_worker_id is null then/i);
  assert.match(sql, /and locked_by=p_worker_id/i);
  assert.match(sql, /update public\.armex_chat_attachments[\s\S]*?set message_id=v_message/);
  assert.match(sql, /get diagnostics v_updated = row_count/);
  assert.match(sql, /if v_updated <> 1 then/);
  assert.ok(
    sql.indexOf("v_debited := public.armex_debit_credits") <
      sql.indexOf("insert into public.armex_messages(conversation_id,user_id,role,content,model,request_id)"),
    "credit debit must happen before the user message is inserted"
  );
});

test("Alpha migration matches the reviewed draft and has valid output guards", async () => {
  const draft = await read("docs/alpha-video/alpha-video-schema-draft.sql");
  const migration = await read("supabase/migrations/20261124054554_alpha_video_jobs.sql");
  assert.equal(migration, draft, "timestamped migration must match the reviewed draft");
  assert.ok(migration.includes("or p_sha256 !~ '^[0-9a-f]{64}$' then"));
  assert.doesNotMatch(migration, /\n then\n\s*raise exception 'Invalid video output metadata'/);
  assert.equal(
    (migration.match(/create or replace function public\.armex_finish_video_job/g) || []).length,
    1,
    "finish function must appear exactly once"
  );
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

test("pinned output transport accepts only globally routable IPv4 addresses", () => {
  for (const address of [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
  ]) assert.equal(isPublicIpv4(address), true, address);

  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.10.20",
    "172.16.0.1",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "01.2.3.4",
    "256.1.1.1",
    "not-an-ip",
  ]) assert.equal(isPublicIpv4(address), false, address);
});
