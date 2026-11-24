import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const BASE = "https://api.appalpha.ir/v1";
const BUCKET = "lokal-chat-media";
const MAX_OUTPUT_BYTES = 250 * 1024 * 1024;
const workerId = crypto.randomUUID();

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error("Missing worker configuration: " + name);
  return value;
}
const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function safeOutputUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("provider_output_url_missing");
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.startsWith("fc") || host.startsWith("fe80:") || host.startsWith("10.") ||
      host.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === "169.254.169.254" || host === "0.0.0.0") {
    throw new Error("provider_output_url_rejected");
  }
  return url.toString();
}

async function providerFetch(path: string, apiKey: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    return await fetch(BASE + path, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: "Bearer " + apiKey,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProviderOutput(raw: unknown): Promise<Response> {
  let url = safeOutputUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(url, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("provider_output_redirect_missing_location");
    url = safeOutputUrl(new URL(location, url).toString());
  }
  throw new Error("provider_output_redirect_limit");
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error("provider_output_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_OUTPUT_BYTES) {
      await reader.cancel();
      throw new Error("video_output_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function markFailed(db: SupabaseClient, jobId: string, code: string) {
  const { error } = await db.rpc("armex_fail_video_job", {
    p_job_id: jobId, p_worker_id: workerId, p_error_code: code.slice(0, 80),
  });
  if (error) throw new Error("VIDEO_FAIL_RPC_" + error.code);
}

async function processOne(db: ReturnType<typeof createClient>, apiKey: string) {
  const { data: job, error: claimError } = await db.rpc("armex_claim_video_job", { p_worker_id: workerId });
  if (claimError) throw new Error("VIDEO_CLAIM_FAILED_" + claimError.code);
  if (!job) return { worked: false };

  const jobId = String(job.id);
  if (job.status === "submitting") {
    try {
      const { data: signed, error: signError } = await db.storage.from(BUCKET)
        .createSignedUrl(String(job.input_storage_path), 3600);
      if (signError || !signed?.signedUrl) throw new Error("input_signing_failed");
      const response = await providerFetch("/generations", apiKey, {
        method: "POST",
        body: JSON.stringify({
          model: "video-wan22",
          image: signed.signedUrl,
          prompt: String(job.prompt),
          cinematic: job.cinematic !== false,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status >= 500 || response.status === 408 || response.status === 429) {
          await db.rpc("armex_video_submission_unknown", { p_job_id: jobId, p_worker_id: workerId });
          return { worked: true, status: "submission_unknown", http_status: response.status };
        }
        await markFailed(db, jobId, String(payload?.error?.code || "alpha_rejected_" + response.status));
        return { worked: true, status: "failed" };
      }
      if (payload?.error || typeof payload?.id !== "string" || !payload.id) {
        await db.rpc("armex_video_submission_unknown", { p_job_id: jobId, p_worker_id: workerId });
        return { worked: true, status: "submission_unknown" };
      }
      const { data: accepted, error: saveError } = await db.rpc("armex_video_submission_result", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_alpha_id: payload.id,
        p_cost_toman: Number.isSafeInteger(Number(payload.cost_toman)) && Number(payload.cost_toman) > 0 ? Number(payload.cost_toman) : 5000,
      });
      if (saveError || accepted !== true) {
        // Provider accepted the generation; never submit it a second time.
        await db.rpc("armex_video_submission_unknown", { p_job_id: jobId, p_worker_id: workerId });
        return { worked: true, status: "submission_unknown" };
      }
      return { worked: true, status: "processing", alpha_id: payload.id };
    } catch (error) {
      // A timeout after POST is ambiguous: Alpha may have accepted and charged it.
      await db.rpc("armex_video_submission_unknown", { p_job_id: jobId, p_worker_id: workerId });
      console.error("Alpha submit outcome is unknown", { jobId, error: String(error).slice(0, 100) });
      return { worked: true, status: "submission_unknown" };
    }
  }

  if (job.status !== "processing" || typeof job.alpha_generation_id !== "string") {
    await markFailed(db, jobId, "invalid_worker_state");
    return { worked: true, status: "failed" };
  }

  if (Date.now() > new Date(String(job.expires_at)).getTime()) {
    await markFailed(db, jobId, "provider_timeout");
    return { worked: true, status: "failed" };
  }

  const alphaId = String(job.alpha_generation_id);
  let statusResponse: Response;
  try {
    statusResponse = await providerFetch("/generations/" + encodeURIComponent(alphaId), apiKey);
  } catch (error) {
    await db.rpc("armex_video_update_progress", {
      p_job_id: jobId, p_worker_id: workerId, p_status: "processing", p_percent: null,
    });
    return { worked: true, status: "processing", transient_error: String(error).slice(0, 80) };
  }
  const statusData = await statusResponse.json().catch(() => ({}));
  if (!statusResponse.ok) {
    await db.rpc("armex_video_update_progress", {
      p_job_id: jobId, p_worker_id: workerId, p_status: "processing", p_percent: null,
    });
    return { worked: true, status: "processing", provider_http_status: statusResponse.status };
  }

  const providerStatus = String(statusData?.status || "processing").toLowerCase();
  if (providerStatus === "failed" || providerStatus === "error") {
    await markFailed(db, jobId, String(statusData?.error?.code || "alpha_generation_failed"));
    return { worked: true, status: "failed" };
  }

  if (providerStatus !== "ready") {
    let percent: number | null = null;
    try {
      const progressResponse = await providerFetch("/generations/" + encodeURIComponent(alphaId) + "/progress", apiKey);
      const progressData = await progressResponse.json().catch(() => ({}));
      const value = Number(progressData?.percent ?? progressData?.progress?.percent);
      if (progressResponse.ok && Number.isInteger(value) && value >= 0 && value <= 99) percent = value;
    } catch { /* Progress is optional; never fabricate a percentage. */ }
    await db.rpc("armex_video_update_progress", {
      p_job_id: jobId, p_worker_id: workerId, p_status: providerStatus, p_percent: percent,
    });
    return { worked: true, status: "processing", progress_percent: percent };
  }

  let outputPath = "";
  try {
    const download = await fetchProviderOutput(statusData?.output?.url);
    if (!download.ok) throw new Error("output_download_http_" + download.status);
    const declaredLength = Number(download.headers.get("content-length") || 0);
    if (declaredLength > MAX_OUTPUT_BYTES) throw new Error("video_output_too_large");
    const contentType = (download.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
      throw new Error("invalid_video_output_content_type");
    }
    const bytes = await readBoundedBody(download);
    if (!bytes.length) throw new Error("video_output_empty");
    if (bytes.length < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") {
      throw new Error("video_mp4_signature_invalid");
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, "0")).join("");
    outputPath = String(job.user_id) + "/video/" + jobId + ".mp4";
    const { error: uploadError } = await db.storage.from(BUCKET).upload(outputPath, new Blob([bytes], { type: "video/mp4" }), {
      contentType: "video/mp4", upsert: false,
    });
    if (uploadError) throw new Error("video_storage_upload_" + uploadError.message);
    const { data: completed, error: finishError } = await db.rpc("armex_finish_video_job", {
      p_job_id: jobId, p_worker_id: workerId, p_storage_path: outputPath,
      p_size_bytes: bytes.length, p_sha256: sha256,
    });
    if (finishError || completed !== true) throw new Error("video_finalize_failed");
    return { worked: true, status: "completed", bytes: bytes.length };
  } catch (error) {
    if (outputPath) await db.storage.from(BUCKET).remove([outputPath]);
    await markFailed(db, jobId, String(error instanceof Error ? error.message : "video_output_invalid"));
    return { worked: true, status: "failed" };
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
  const expected = required("ALPHA_VIDEO_WORKER_SECRET");
  const supplied = request.headers.get("x-worker-secret") || "";
  if (!supplied || supplied !== expected) return json({ success: false, error: "unauthorized" }, 401);

  try {
    const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const result = await processOne(db, required("ALPHA_API_KEY"));
    return result.worked ? json({ success: true, ...result }, 200) : new Response(null, { status: 204 });
  } catch (error) {
    console.error("Alpha video worker failed", String(error).slice(0, 200));
    return json({ success: false, error: "worker_failed" }, 500);
  }
});
