import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const BASE = "https://api.appalpha.ir/v1";
const BUCKET = "lokal-chat-media";
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const workerId = crypto.randomUUID();
type WorkerDb = SupabaseClient<any, "public", "public", any, any>;

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error("Missing worker configuration: " + name);
  return value;
}
const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function parseOutputHosts(raw: string): Set<string> {
  const hosts = raw.split(",").map((item) => item.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  if (!hosts.length || hosts.some((host) =>
    host.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
  )) {
    throw new Error("invalid_alpha_output_host_allowlist");
  }
  return new Set(hosts);
}

function safeOutputUrl(raw: unknown, allowedHosts: Set<string>): string {
  if (typeof raw !== "string") throw new Error("provider_output_url_missing");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("provider_output_url_invalid"); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const isIpLiteral = host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.port !== "" && url.port !== "443") || isIpLiteral ||
      !allowedHosts.has(host)) {
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

function isPublicIpv4(raw: string): boolean {
  const parts = raw.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b, c] = parts.map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255) return false;
  return true;
}

async function assertPublicDns(host: string): Promise<void> {
  let ipv4: string[];
  let ipv6: string[];
  try {
    [ipv4, ipv6] = await Promise.all([
      Deno.resolveDns(host, "A"),
      Deno.resolveDns(host, "AAAA"),
    ]);
  } catch {
    throw new Error("provider_output_dns_resolution_failed");
  }
  // This worker intentionally supports IPv4-only output hosts until IPv6
  // classification and destination pinning are implemented by the egress layer.
  if (!ipv4.length || ipv6.length || ipv4.some((address) => !isPublicIpv4(address))) {
    throw new Error("provider_output_dns_not_public_ipv4_only");
  }
}

async function fetchProviderOutput(raw: unknown, allowedHosts: Set<string>): Promise<Response> {
  let url = safeOutputUrl(raw, allowedHosts);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicDns(new URL(url).hostname);
    const response = await fetch(url, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("provider_output_redirect_missing_location");
    url = safeOutputUrl(new URL(location, url).toString(), allowedHosts);
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

async function markFailed(db: WorkerDb, jobId: string, code: string) {
  const { error } = await db.rpc("armex_fail_video_job", {
    p_job_id: jobId, p_worker_id: workerId, p_error_code: code.slice(0, 80),
  });
  if (error) throw new Error("VIDEO_FAIL_RPC_" + error.code);
}

async function processOne(db: WorkerDb, apiKey: string, allowedOutputHosts: Set<string>) {
  const { data: job, error: claimError } = await db.rpc("armex_claim_video_job", { p_worker_id: workerId });
  if (claimError) throw new Error("VIDEO_CLAIM_FAILED_" + claimError.code);
  if (!job) return { worked: false };

  const jobId = String(job.id);
  if (job.status === "submitting") {
    // Distinguish local preparation failures from an ambiguous provider POST.
    // Only a request that may have reached Alpha must remain submission_unknown.
    let postAttempted = false;
    try {
      const { data: signed, error: signError } = await db.storage.from(BUCKET)
        .createSignedUrl(String(job.input_storage_path), 3600);
      if (signError || !signed?.signedUrl) throw new Error("input_signing_failed");
      postAttempted = true;
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
      if (!postAttempted) {
        // No provider request was started, so this is a definite local failure.
        await markFailed(db, jobId, "input_signing_failed");
        console.error("Alpha input preparation failed before submission", {
          jobId, error: String(error).slice(0, 100),
        });
        return { worked: true, status: "failed" };
      }
      // Once POST starts, a timeout or transport error is ambiguous: Alpha may
      // have accepted and charged it. Never retry automatically.
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
  let finishAttempted = false;
  try {
    const download = await fetchProviderOutput(statusData?.output?.url, allowedOutputHosts);
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
    const outputBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(outputBuffer).set(bytes);
    const digest = await crypto.subtle.digest("SHA-256", outputBuffer);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, "0")).join("");
    outputPath = String(job.user_id) + "/video/" + jobId + ".mp4";
    await db.storage.from(BUCKET).remove([outputPath]);
    const { error: uploadError } = await db.storage.from(BUCKET).upload(outputPath, new Blob([outputBuffer], { type: "video/mp4" }), {
      contentType: "video/mp4", upsert: false,
    });
    if (uploadError) throw new Error("video_storage_upload_" + uploadError.message);
    finishAttempted = true;
    const { data: completed, error: finishError } = await db.rpc("armex_finish_video_job", {
      p_job_id: jobId, p_worker_id: workerId, p_storage_path: outputPath,
      p_size_bytes: bytes.length, p_sha256: sha256,
    });
    if (!finishError && completed === true) {
      return { worked: true, status: "completed", bytes: bytes.length };
    }

    // The RPC may have committed even if its response was lost. Reconcile before
    // deleting the object or refunding credits.
    const { data: reconciled, error: reconcileError } = await db.from("armex_video_generations")
      .select("status,output_storage_path")
      .eq("id", jobId)
      .maybeSingle();
    if (!reconcileError && reconciled?.status === "completed" &&
        reconciled.output_storage_path === outputPath) {
      return { worked: true, status: "completed", bytes: bytes.length, reconciled: true };
    }
    console.error("Alpha video finalization needs reconciliation", {
      jobId, rpcError: finishError?.code || null,
      reconcileError: reconcileError?.code || null,
      observedStatus: reconciled?.status || null,
    });
    return { worked: true, status: "finalization_unknown" };
  } catch (error) {
    if (finishAttempted) {
      // Keep the object: the DB transaction may already have committed.
      console.error("Alpha video finalization outcome is unknown", {
        jobId, error: String(error).slice(0, 100),
      });
      return { worked: true, status: "finalization_unknown" };
    }
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
    const allowedOutputHosts = parseOutputHosts(required("ALPHA_OUTPUT_HOSTS"));
    const result = await processOne(db, required("ALPHA_API_KEY"), allowedOutputHosts);
    return result.worked ? json({ success: true, ...result }, 200) : new Response(null, { status: 204 });
  } catch (error) {
    console.error("Alpha video worker failed", String(error).slice(0, 200));
    return json({ success: false, error: "worker_failed" }, 500);
  }
});
