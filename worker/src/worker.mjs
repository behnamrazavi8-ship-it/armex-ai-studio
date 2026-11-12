import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { decodeCloudflareImageOutput } from "./image-output.mjs";
import { hashBytes, promptFingerprint } from "./diagnostics.mjs";
import { compareStoredImageBytes, isRetryableHttpStatus, shouldRemoveUncommittedUpload } from "./job-safety.mjs";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
};

const SUPABASE_URL = required("SUPABASE_URL").replace(/\/$/, "");
const SUPABASE_API_KEY = process.env.SUPABASE_SECRET_KEY?.trim() ||
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!SUPABASE_API_KEY) throw new Error("Missing required environment variable: SUPABASE_SECRET_KEY");
const CLOUDFLARE_ACCOUNT_ID = required("CLOUDFLARE_ACCOUNT_ID");
const CLOUDFLARE_API_TOKEN = required("CLOUDFLARE_API_TOKEN");
const IMAGE_BUCKET = "lokal-ai-images";
const VERIFY_STORED_IMAGE_BYTES = process.env.VERIFY_STORED_IMAGE_BYTES === "true";
const DEFAULT_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const POLL_MS = Math.min(15000, Math.max(1000, Number(process.env.WORKER_POLL_MS || 2500)));
const workerId = randomUUID();
let stopping = false;
let activeJob = false;

const log = (event, fields = {}) => {
  // Never log prompts, image bytes, tokens, or authorization headers.
  console.log(JSON.stringify({ at: new Date().toISOString(), service: "lokal-ai-image-worker", event, ...fields }));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function supabase(path, options = {}) {
  const response = await fetch(SUPABASE_URL + path, {
    ...options,
    headers: {
      apikey: SUPABASE_API_KEY,
      Authorization: "Bearer " + SUPABASE_API_KEY,
      ...(options.headers || {}),
    },
  });
  const body = await response.text();
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
  if (!response.ok) {
    const error = new Error("SUPABASE_HTTP_" + response.status);
    error.retryable = isRetryableHttpStatus(response.status);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

async function rpc(name, args) {
  return supabase("/rest/v1/rpc/" + name, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15000),
  });
}

async function claimJob() {
  return rpc("armex_claim_image_job", { p_worker_id: workerId });
}

async function heartbeat(jobId) {
  return rpc("armex_heartbeat_image_job", {
    p_job_id: jobId,
    p_worker_id: workerId,
  });
}

async function runProvider(job) {
  const model = job.model || DEFAULT_MODEL;
  const url = "https://api.cloudflare.com/client/v4/accounts/" +
    CLOUDFLARE_ACCOUNT_ID + "/ai/run/" + model;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + CLOUDFLARE_API_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: job.prompt, steps: 4 }),
    signal: AbortSignal.timeout(110000),
  });

  if (!response.ok) {
    const error = new Error("IMAGE_PROVIDER_HTTP_" + response.status);
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    error.status = response.status;
    throw error;
  }

  const contentType = response.headers.get("content-type") || "unknown";
  const payload = await response.json();
  try {
    const image = decodeCloudflareImageOutput(payload);
    return {
      ...image,
      provider: {
        http_status: response.status,
        content_type: contentType.slice(0, 100),
        has_result_image: typeof payload?.result?.image === "string",
        has_top_level_image: typeof payload?.image === "string",
      },
    };
  } catch (error) {
    error.retryable = false;
    throw error;
  }
}

async function uploadImage(path, bytes, mimeType) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    SUPABASE_URL + "/storage/v1/object/" + IMAGE_BUCKET + "/" + encodedPath,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_API_KEY,
        Authorization: "Bearer " + SUPABASE_API_KEY,
        "Content-Type": mimeType,
        "x-upsert": "true",
        "Cache-Control": "3600",
      },
      body: bytes,
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) {
    const error = new Error("IMAGE_STORAGE_HTTP_" + response.status);
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    error.status = response.status;
    throw error;
  }
}

async function verifyStoredImage(path, expectedSha256) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    SUPABASE_URL + "/storage/v1/object/" + IMAGE_BUCKET + "/" + encodedPath,
    {
      method: "GET",
      headers: {
        apikey: SUPABASE_API_KEY,
        Authorization: "Bearer " + SUPABASE_API_KEY,
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) {
    log("storage_verify_failed", { status: response.status });
    return;
  }
  const storedBytes = Buffer.from(await response.arrayBuffer());
  log("storage_bytes_verified", compareStoredImageBytes(storedBytes, expectedSha256));
}

async function removeImage(path) {
  try {
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/" + IMAGE_BUCKET, {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_API_KEY,
        Authorization: "Bearer " + SUPABASE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefixes: [path] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) log("storage_cleanup_failed", { status: response.status });
  } catch {
    log("storage_cleanup_failed", { reason: "network_error" });
  }
}

async function removeImageIfJobNotCompleted(jobId, path) {
  try {
    const rows = await supabase(
      "/rest/v1/armex_image_generations?id=eq." + encodeURIComponent(jobId) + "&select=status",
      { method: "GET", signal: AbortSignal.timeout(10000) },
    );
    const generationStatus = Array.isArray(rows) ? rows[0]?.status : null;
    if (!shouldRemoveUncommittedUpload({ uploadAttempted: true, storagePath: path, generationStatus })) return;
    await removeImage(path);
  } catch {
    // Prefer retaining a possible completed output over deleting it after an
    // ambiguous network failure. A later reconciliation can clean orphan files.
    log("storage_cleanup_skipped_ambiguous_job_state", { job_id: jobId });
  }
}

async function processJob(job) {
  const jobId = job.job_id;
  // Each worker attempt writes to its own object so a stale lease owner cannot
  // delete or overwrite a newer worker's output.
  let storagePath = null;
  let leaseLost = false;
  let uploadAttempted = false;
  let heartbeatBusy = false;

  const heartbeatTimer = setInterval(async () => {
    if (heartbeatBusy || leaseLost) return;
    heartbeatBusy = true;
    try {
      const alive = await heartbeat(jobId);
      if (alive !== true) {
        leaseLost = true;
        log("lease_lost", { job_id: jobId });
      }
    } catch {
      // A transient heartbeat error is retried on the next interval. The DB lease
      // remains authoritative; completion will be rejected if ownership is lost.
      log("heartbeat_error", { job_id: jobId });
    } finally {
      heartbeatBusy = false;
    }
  }, 45000);

  try {
    const promptInfo = promptFingerprint(job.prompt);
    log("job_started", {
      job_id: jobId,
      attempt: job.attempt_count,
      model: job.model || DEFAULT_MODEL,
      prompt_length: promptInfo.length,
      prompt_sha256: promptInfo.sha256,
    });
    const output = await runProvider(job);
    const providerBytesSha256 = hashBytes(output.bytes);
    log("provider_output_received", {
      job_id: jobId,
      ...output.provider,
      image_bytes: output.bytes.length,
      image_sha256: providerBytesSha256,
      image_mime_type: output.mimeType,
      image_signature: output.extension,
    });
    storagePath = job.user_id + "/" + job.request_id + "-" + workerId + "." + output.extension;
    if (leaseLost) {
      log("job_abandoned_after_lease_loss", { job_id: jobId });
      return;
    }

    // A timeout may occur after Storage accepted the object but before its response arrived.
    // Mark the attempt before the request so the catch path also checks for that orphan.
    uploadAttempted = true;
    await uploadImage(storagePath, output.bytes, output.mimeType);
    if (VERIFY_STORED_IMAGE_BYTES) {
      await verifyStoredImage(storagePath, providerBytesSha256);
    }
    if (leaseLost) {
      await removeImage(storagePath);
      log("job_abandoned_after_upload_lease_loss", { job_id: jobId });
      return;
    }

    const completed = await rpc("armex_complete_image_job", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_storage_path: storagePath,
      p_mime_type: output.mimeType,
      p_actual_cost_usd: null,
    });

    if (completed !== true) {
      await removeImage(storagePath);
      log("completion_rejected", { job_id: jobId });
      return;
    }

    log("job_completed", { job_id: jobId, bytes: output.bytes.length });
  } catch (error) {
    if (leaseLost) {
      log("job_error_after_lease_loss", { job_id: jobId, code: error?.message || "unknown" });
      return;
    }
    const code = String(error?.message || "worker_error").replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 80);
    const retryable = error?.retryable !== false;
    try {
      const result = await rpc("armex_fail_image_job", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_error_code: code,
        p_retryable: retryable,
      });
      log("job_failed", {
        job_id: jobId,
        code,
        http_status: error?.status || null,
        retryable,
        outcome: result?.status || result?.code || "unknown",
      });
    } catch {
      // If the failure update cannot reach Postgres, the lease expiry path will
      // safely reclaim or terminally refund the job.
      log("failure_record_deferred_to_lease_recovery", { job_id: jobId, code });
    }
    if (uploadAttempted && storagePath) await removeImageIfJobNotCompleted(jobId, storagePath);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

const healthServer = createServer((request, response) => {
  if (request.url === "/health" || request.url === "/") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      service: "lokal-ai-image-worker",
      status: stopping ? "stopping" : "ok",
      active_job: activeJob,
      worker_id: workerId,
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});

const port = Number(process.env.PORT || 8080);
healthServer.listen(port, "0.0.0.0", () => log("health_server_started", { port, worker_id: workerId }));

process.on("SIGTERM", () => { stopping = true; log("shutdown_requested"); });
process.on("SIGINT", () => { stopping = true; log("shutdown_requested"); });

log("worker_started", { worker_id: workerId, poll_ms: POLL_MS });

while (!stopping) {
  if (activeJob) {
    await sleep(POLL_MS);
    continue;
  }
  try {
    const job = await claimJob();
    if (!job) {
      await sleep(POLL_MS);
      continue;
    }
    activeJob = true;
    try {
      await processJob(job);
    } finally {
      activeJob = false;
    }
  } catch (error) {
    log("poll_error", { code: String(error?.message || "unknown").slice(0, 80) });
    await sleep(Math.max(POLL_MS, 5000));
  }
}

healthServer.close(() => log("health_server_stopped"));
