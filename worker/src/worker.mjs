import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
// This branch is intentionally restricted to the image-edit queue for safe testing.
import { supabaseAuthHeaders } from "./supabase-auth.mjs";

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
const DEFAULT_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const POLL_MS = Math.min(15000, Math.max(1000, Number(process.env.WORKER_POLL_MS || 2500)));
const workerId = randomUUID();
sharp.concurrency(1);
sharp.cache({ memory: 64, files: 0, items: 10 });
let stopping = false;
let activeJob = false;

const log = (event, fields = {}) => {
  // Never log prompts, image bytes, tokens, or authorization headers.
  console.log(JSON.stringify({ at: new Date().toISOString(), service: "lokal-ai-image-edit-test-worker", event, ...fields }));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function supabase(path, options = {}) {
  const response = await fetch(SUPABASE_URL + path, {
    ...options,
    headers: {
      ...supabaseAuthHeaders(SUPABASE_API_KEY),
      ...(options.headers || {}),
    },
  });
  const body = await response.text();
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
  if (!response.ok) {
    const error = new Error("SUPABASE_HTTP_" + response.status);
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
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

async function claimImageEditJob() {
  try { return await rpc("armex_claim_image_edit_job", { p_worker_id: workerId }); }
  catch (error) {
    // Keep the existing text-to-image queue operational before the edit migration is applied.
    if (error?.status === 404) return null;
    throw error;
  }
}

async function heartbeatImageEdit(jobId) {
  return rpc("armex_heartbeat_image_edit_job", { p_job_id: jobId, p_worker_id: workerId });
}

async function runImageEditProvider(job) {
  const encodedPath = String(job.input_storage_path || "").split("/").map(encodeURIComponent).join("/");
  const inputResponse = await fetch(
    SUPABASE_URL + "/storage/v1/object/" + IMAGE_BUCKET + "/" + encodedPath,
    { headers: supabaseAuthHeaders(SUPABASE_API_KEY), signal: AbortSignal.timeout(30000) },
  );
  if (!inputResponse.ok) {
    const error = new Error("IMAGE_EDIT_INPUT_HTTP_" + inputResponse.status);
    error.retryable = inputResponse.status === 408 || inputResponse.status === 429 || inputResponse.status >= 500;
    error.status = inputResponse.status;
    throw error;
  }
  const inputBytes = new Uint8Array(await inputResponse.arrayBuffer());
  if (!inputBytes.length || inputBytes.length > 5 * 1024 * 1024) {
    const error = new Error("IMAGE_EDIT_INPUT_SIZE_INVALID"); error.retryable = false; throw error;
  }
  const inputType = inputResponse.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  if (!["image/jpeg", "image/png", "image/webp"].includes(inputType)) {
    const error = new Error("IMAGE_EDIT_INPUT_TYPE_INVALID"); error.retryable = false; throw error;
  }

  // FLUX.2 Klein 4B requires reference images below 512x512. Normalize
  // orientation, preserve aspect ratio, and resize locally before multipart upload.
  let modelInput;
  try {
    modelInput = await sharp(Buffer.from(inputBytes), { limitInputPixels: 20000000 })
      .rotate()
      .resize({ width: 511, height: 511, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    const error = new Error("IMAGE_EDIT_INPUT_DECODE_FAILED"); error.retryable = false; throw error;
  }

  const form = new FormData();
  form.append(
    "prompt",
    "Apply only the changes requested below. Preserve the original subject identity and recognizable features, proportions, pose, framing, and every unmentioned detail as faithfully as possible. Do not add or remove objects unless explicitly requested. User edit request: " + job.prompt,
  );
  form.append("input_image_0", new Blob([modelInput], { type: "image/jpeg" }), "input.jpg");
  const url = "https://api.cloudflare.com/client/v4/accounts/" + CLOUDFLARE_ACCOUNT_ID +
    "/ai/run/@cf/black-forest-labs/flux-2-klein-4b";
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + CLOUDFLARE_API_TOKEN },
    body: form,
    signal: AbortSignal.timeout(150000),
  });
  if (!response.ok) {
    const error = new Error("IMAGE_EDIT_PROVIDER_HTTP_" + response.status);
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  const imageBase64 = typeof payload?.result?.image === "string"
    ? payload.result.image
    : typeof payload?.image === "string" ? payload.image : "";
  if (!imageBase64 || imageBase64.length > 28000000) {
    const error = new Error("IMAGE_EDIT_INVALID_PROVIDER_RESPONSE"); error.retryable = false; throw error;
  }
  const bytes = Buffer.from(imageBase64, "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) {
    const error = new Error("IMAGE_EDIT_OUTPUT_SIZE_INVALID"); error.retryable = false; throw error;
  }
  return { bytes, mimeType: "image/jpeg" };
}

async function removeImageEditIfJobNotCompleted(jobId, path) {
  try {
    const rows = await supabase(
      "/rest/v1/armex_image_edit_jobs?id=eq." + encodeURIComponent(jobId) + "&select=status",
      { method: "GET", signal: AbortSignal.timeout(10000) },
    );
    if (!Array.isArray(rows) || !rows.length) {
      log("image_edit_storage_cleanup_skipped_unknown_job", { job_id: jobId });
      return;
    }
    if (rows[0].status !== "completed") await removeImage(path);
  } catch {
    // Never delete an output if the database outcome cannot be established.
    log("image_edit_storage_cleanup_skipped_ambiguous_job_state", { job_id: jobId });
  }
}

async function processImageEditJob(job) {
  const jobId = job.job_id;
  const storagePath = job.user_id + "/edit/" + job.request_id + "-" + workerId + "-output.jpg";
  let leaseLost = false;
  let uploadAttempted = false;
  let heartbeatBusy = false;
  const timer = setInterval(async () => {
    if (heartbeatBusy || leaseLost) return;
    heartbeatBusy = true;
    try {
      if (await heartbeatImageEdit(jobId) !== true) {
        leaseLost = true;
        log("image_edit_lease_lost", { job_id: jobId });
      }
    } catch { log("image_edit_heartbeat_error", { job_id: jobId }); }
    finally { heartbeatBusy = false; }
  }, 45000);

  try {
    log("image_edit_started", { job_id: jobId, attempt: job.attempt_count, model: job.model });
    const output = await runImageEditProvider(job);
    if (leaseLost) return;
    uploadAttempted = true;
    await uploadImage(storagePath, output.bytes, output.mimeType);
    if (leaseLost) {
      await removeImage(storagePath);
      return;
    }
    const completed = await rpc("armex_complete_image_edit_job", {
      p_job_id: jobId, p_worker_id: workerId, p_output_storage_path: storagePath,
    });
    if (completed !== true) {
      await removeImage(storagePath);
      log("image_edit_completion_rejected", { job_id: jobId });
      return;
    }
    log("image_edit_completed", { job_id: jobId, bytes: output.bytes.length });
  } catch (error) {
    if (leaseLost) return;
    const code = String(error?.message || "image_edit_worker_error").replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 80);
    try {
      const result = await rpc("armex_fail_image_edit_job", {
        p_job_id: jobId, p_worker_id: workerId, p_error_code: code,
        p_retryable: error?.retryable !== false,
      });
      log("image_edit_failed", { job_id: jobId, code, outcome: result?.status || result?.code || "unknown" });
    } catch {
      log("image_edit_failure_deferred_to_lease_recovery", { job_id: jobId, code });
    }
    if (uploadAttempted) await removeImageEditIfJobNotCompleted(jobId, storagePath);
  } finally {
    clearInterval(timer);
  }
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

  const payload = await response.json();
  const imageBase64 = typeof payload?.result?.image === "string"
    ? payload.result.image
    : typeof payload?.image === "string" ? payload.image : "";
  if (!imageBase64 || imageBase64.length > 28000000) {
    const error = new Error("INVALID_IMAGE_PROVIDER_RESPONSE");
    error.retryable = false;
    throw error;
  }

  const bytes = Buffer.from(imageBase64, "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) {
    const error = new Error("IMAGE_SIZE_LIMIT");
    error.retryable = false;
    throw error;
  }
  return { bytes, mimeType: "image/jpeg", extension: "jpg" };
}

async function uploadImage(path, bytes, mimeType) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    SUPABASE_URL + "/storage/v1/object/" + IMAGE_BUCKET + "/" + encodedPath,
    {
      method: "POST",
      headers: {
        ...supabaseAuthHeaders(SUPABASE_API_KEY),
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

async function removeImage(path) {
  try {
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/" + IMAGE_BUCKET, {
      method: "DELETE",
      headers: {
        ...supabaseAuthHeaders(SUPABASE_API_KEY),
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
    if (Array.isArray(rows) && rows[0]?.status === "completed") return;
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
  const storagePath = job.user_id + "/" + job.request_id + "-" + workerId + ".jpg";
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
    log("job_started", { job_id: jobId, attempt: job.attempt_count, model: job.model });
    const output = await runProvider(job);
    if (leaseLost) {
      log("job_abandoned_after_lease_loss", { job_id: jobId });
      return;
    }

    // A timeout may occur after Storage accepted the object but before its response arrived.
    // Mark the attempt before the request so the catch path also checks for that orphan.
    uploadAttempted = true;
    await uploadImage(storagePath, output.bytes, output.mimeType);
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
        retryable,
        outcome: result?.status || result?.code || "unknown",
      });
    } catch {
      // If the failure update cannot reach Postgres, the lease expiry path will
      // safely reclaim or terminally refund the job.
      log("failure_record_deferred_to_lease_recovery", { job_id: jobId, code });
    }
    if (uploadAttempted) await removeImageIfJobNotCompleted(jobId, storagePath);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

const healthServer = createServer((request, response) => {
  if (request.url === "/health" || request.url === "/") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      service: "lokal-ai-image-edit-test-worker",
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

// Temporary isolated runtime: process image-edit jobs only.
// It deliberately never claims from the production text-to-image queue.
while (!stopping) {
  if (activeJob) {
    await sleep(POLL_MS);
    continue;
  }
  try {
    const editJob = await claimImageEditJob();
    if (!editJob) {
      await sleep(POLL_MS);
      continue;
    }
    activeJob = true;
    try {
      await processImageEditJob(editJob);
    } finally {
      activeJob = false;
    }
  } catch (error) {
    log("image_edit_poll_error", { code: String(error?.message || "unknown").slice(0, 80) });
    await sleep(Math.max(POLL_MS, 5000));
  }
}
healthServer.close(() => log("health_server_stopped"));
