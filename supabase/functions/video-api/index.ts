import { createSupabaseContext } from "npm:@supabase/server@1";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type Json = Record<string, unknown>;

const VIDEO_BUCKET = "lokal-ai-videos";
const VIDEO_MODEL = "wan2.2-ti2v-5b";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (body: Json, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

const allowedOrigins = (): string[] =>
  (Deno.env.get("ALLOWED_ORIGINS") || "https://lokal-ai.net,https://www.lokal-ai.net")
    .split(",").map((value) => value.trim()).filter(Boolean);

const corsFor = (origin: string | null): HeadersInit => {
  const accepted = origin && allowedOrigins().includes(origin) ? origin : "";
  return {
    ...(accepted ? { "Access-Control-Allow-Origin": accepted } : {}),
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
};

const fail = (message: string, status: number, cors: HeadersInit) =>
  json({ success: false, error: message }, status, cors);

const readCreditCost = (): number => {
  const raw = Deno.env.get("VIDEO_CREDIT_COST") || "";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100000) {
    throw new Error("VIDEO_BILLING_NOT_CONFIGURED");
  }
  return value;
};

const handle = async (request: Request): Promise<Response> => {
  const origin = request.headers.get("Origin");
  const cors = corsFor(origin);

  if (request.method === "OPTIONS") {
    if (origin && !allowedOrigins().includes(origin)) return new Response(null, { status: 403, headers: cors });
    return new Response(null, { status: 204, headers: cors });
  }
  if (origin && !allowedOrigins().includes(origin)) return fail("Origin not allowed", 403, cors);
  if (request.method !== "POST") return fail("Method not allowed", 405, cors);

  const { data: context, error: authError } =
    await createSupabaseContext(request, { auth: "user" });
  const userId = context?.userClaims?.id;
  const db = context?.supabaseAdmin as SupabaseClient | undefined;
  if (authError || typeof userId !== "string" || !db) {
    return fail("Invalid or expired session", authError?.status || 401, cors);
  }

  let body: Json;
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return fail("Invalid request body", 400, cors);
    }
    body = value as Json;
  } catch {
    return fail("Invalid JSON body", 400, cors);
  }

  const action = body.action;
  if (action === "submit") {
    const requestId = typeof body.request_id === "string" ? body.request_id : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const settings = body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
      ? body.settings as Record<string, unknown>
      : {};
    const size = settings.size;
    if (!UUID_RE.test(requestId)) return fail("A valid request_id UUID is required", 400, cors);
    if (!prompt || prompt.length > 6000) return fail("Prompt must contain 1 to 6000 characters", 400, cors);
    if (size !== "1280*704" && size !== "704*1280") {
      return fail("Unsupported video size", 400, cors);
    }

    let credits: number;
    try { credits = readCreditCost(); }
    catch { return fail("Video billing is not configured", 503, cors); }

    const { data, error } = await db.rpc("lokal_enqueue_video_generation", {
      p_user_id: userId,
      p_request_id: requestId,
      p_prompt: prompt,
      p_settings: { size },
      p_credits: credits,
    });
    if (error || !data || typeof data !== "object") {
      console.error("Video enqueue failed", { code: error?.code || "invalid_result" });
      return fail("Could not enqueue video generation", 500, cors);
    }
    const result = data as Record<string, unknown>;
    if (result.success !== true) {
      return fail(result.code === "insufficient_credits" ? "Insufficient credits" : "Video request could not be accepted",
        result.code === "insufficient_credits" ? 402 : 409, cors);
    }
    return json({
      success: true,
      duplicate: result.duplicate === true,
      job_id: result.job_id,
      request_id: requestId,
      status: result.status,
      model: VIDEO_MODEL,
    }, result.duplicate === true ? 200 : 202, cors);
  }

  if (action === "status") {
    const requestId = typeof body.request_id === "string" ? body.request_id : "";
    if (!UUID_RE.test(requestId)) return fail("A valid request_id UUID is required", 400, cors);
    const { data, error } = await db.rpc("lokal_get_video_job_status", {
      p_user_id: userId,
      p_request_id: requestId,
    });
    if (error) {
      console.error("Video status lookup failed", { code: error.code });
      return fail("Could not load video status", 500, cors);
    }
    if (!data || typeof data !== "object") return fail("Video job not found", 404, cors);

    const result = data as Record<string, unknown>;
    let videoUrl: string | null = null;
    if (result.status === "completed" && typeof result.storage_path === "string") {
      const { data: signed, error: signError } = await db.storage
        .from(VIDEO_BUCKET).createSignedUrl(result.storage_path, 3600);
      if (!signError && signed?.signedUrl) videoUrl = signed.signedUrl;
      else console.warn("Video output is complete but signed URL creation failed", { requestId });
    }

    return json({
      success: true,
      request_id: requestId,
      job_id: result.job_id,
      status: result.status,
      model: result.model,
      credits_charged: result.credits_charged,
      error_code: result.error_code,
      created_at: result.created_at,
      completed_at: result.completed_at,
      video_url: videoUrl,
      video_url_expires_in: videoUrl ? 3600 : null,
    }, 200, cors);
  }

  return fail("Unsupported action", 400, cors);
};

Deno.serve(handle);
