import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const VIDEO_BUCKET = "lokal-chat-media";
const VIDEO_MODEL = "video-wan22";
const MAX_PROMPT_CHARS = 1800;
const json = (data: Record<string, unknown>, status = 200, cors: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
const fail = (error: string, status: number, cors: HeadersInit) =>
  json({ success: false, error }, status, cors);
const validUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const creditCost = (): number => {
  const value = Number(Deno.env.get("ALPHA_VIDEO_CREDIT_COST") ?? "0");
  return Number.isSafeInteger(value) && value > 0 && value <= 100000 ? value : 0;
};

async function signedVideoUrl(db: SupabaseClient, path: string): Promise<string> {
  const { data, error } = await db.storage.from(VIDEO_BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) throw new Error("VIDEO_SIGNING_FAILED");
  return data.signedUrl;
}

function safeJob(job: Record<string, unknown>, videoUrl: string | null = null) {
  return {
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    model: job.model || VIDEO_MODEL,
    cinematic: job.cinematic,
    progress_percent: job.progress_percent ?? null,
    credits_reserved: job.credits_reserved,
    error_code: job.error_code,
    created_at: job.created_at,
    completed_at: job.completed_at,
    video_url: videoUrl,
    conversation_id: job.conversation_id,
  };
}

export async function handleAlphaVideoApi(
  db: SupabaseClient,
  userId: string,
  action: string,
  body: Record<string, unknown> | null,
  jobId: string,
  cors: HeadersInit,
): Promise<Response> {
  if (action === "create_alpha_video") {
    if (!body) return fail("درخواست ساخت ویدئو معتبر نیست.", 400, cors);
    const requestId = validUuid(body.request_id) ? body.request_id : "";
    const attachmentId = validUuid(body.attachment_id) ? body.attachment_id : "";
    const conversationId = validUuid(body.conversation_id) ? body.conversation_id : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const cinematic = body.cinematic !== false;
    const credits = creditCost();

    if (!requestId || !attachmentId || !conversationId ||
        !prompt || prompt.length > MAX_PROMPT_CHARS) {
      return fail("شناسه درخواست، تصویر و توضیح معتبر لازم است.", 400, cors);
    }
    if (!credits) {
      return fail("هزینه اعتباری موتور ویدئو هنوز در تنظیمات امن سرور تعیین نشده است؛ هیچ اعتباری رزرو نشد.", 503, cors);
    }

    const { data: attachment, error: attachmentError } = await db.from("armex_chat_attachments")
      .select("id,conversation_id,storage_path,mime_type,status,size_bytes")
      .eq("id", attachmentId).eq("user_id", userId).eq("status", "ready").maybeSingle();
    if (attachmentError || !attachment) return fail("تصویر ورودی پیدا نشد یا هنوز آماده نیست.", 404, cors);
    if (!["image/jpeg", "image/png", "image/webp"].includes(String(attachment.mime_type)) ||
        !String(attachment.storage_path).startsWith(userId + "/")) {
      return fail("فرمت یا مسیر تصویر ورودی معتبر نیست.", 415, cors);
    }
    if (conversationId && attachment.conversation_id !== conversationId) {
      return fail("تصویر به گفتگوی انتخاب‌شده تعلق ندارد.", 403, cors);
    }

    const { data, error } = await db.rpc("armex_create_video_job", {
      p_user_id: userId,
      p_request_id: requestId,
      p_conversation_id: conversationId,
      p_attachment_id: attachmentId,
      p_prompt: prompt,
      p_cinematic: cinematic,
      p_credits: credits,
    });
    if (error || !data) {
      console.error("Alpha video enqueue failed", { requestId, code: error?.code });
      return fail("ثبت درخواست ویدئو انجام نشد؛ اعتبار رزرو نشد.", 500, cors);
    }
    if (data.success !== true) {
      if (data.code === "insufficient_credits") return fail("اعتبار کیف پول برای ساخت ویدئو کافی نیست.", 402, cors);
      return fail("درخواست ویدئو پذیرفته نشد.", 409, cors);
    }
    return json({
      success: true,
      duplicate: data.duplicate === true,
      job: { id: data.job_id, status: data.status || "queued", conversation_id: data.conversation_id },
      credits_reserved: data.credits_reserved,
      message: "درخواست در صف امن قرار گرفت؛ پس از تکمیل Worker خروجی را ذخیره می‌کند.",
    }, 202, cors);
  }

  if (action === "alpha_video_status" || action === "alpha_video_history") {
    let query = db.from("armex_video_generations")
      .select("id,user_id,conversation_id,prompt,model,cinematic,status,progress_percent,credits_reserved,error_code,output_storage_path,created_at,completed_at")
      .eq("user_id", userId);
    if (action === "alpha_video_status") {
      if (!validUuid(jobId)) return fail("شناسه درخواست معتبر نیست.", 400, cors);
      query = query.eq("id", jobId);
    } else {
      query = query.order("created_at", { ascending: false }).limit(20);
    }
    const { data, error } = await query;
    if (error) {
      console.error("Alpha video history lookup failed", { userId, code: error.code });
      return fail("تاریخچه ویدئو در دسترس نیست؛ ابتدا طرح پایگاه داده باید اعمال شود.", 503, cors);
    }
    const rows = action === "alpha_video_status" ? (data?.[0] ? [data[0]] : []) : (data ?? []);
    if (action === "alpha_video_status" && !rows.length) return fail("درخواست ویدئو پیدا نشد.", 404, cors);
    const jobs = await Promise.all(rows.map(async (job: Record<string, unknown>) => {
      let url: string | null = null;
      if (job.status === "completed" && job.output_storage_path) {
        try { url = await signedVideoUrl(db, String(job.output_storage_path)); }
        catch { /* A later history refresh can mint a fresh signed URL. */ }
      }
      return safeJob(job, url);
    }));
    return action === "alpha_video_status"
      ? json({ success: true, job: jobs[0] }, 200, cors)
      : json({ success: true, jobs }, 200, cors);
  }

  return fail("عملیات ویدئو نامعتبر است.", 400, cors);
}
