import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "lokal-ai-images";
const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const json = (data: Record<string, unknown>, status = 200, cors: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
const fail = (error: string, status: number, cors: HeadersInit) => json({ success: false, error }, status, cors);
const validUuid = (v: unknown): v is string => typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

function decodeImage(value: string, mime: string): Uint8Array | null {
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) return null;
  try {
    const binary = atob(value);
    if (!binary.length || binary.length > MAX_INPUT_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const webp = bytes.length > 12 && String.fromCharCode(...bytes.slice(0,4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8,12)) === "WEBP";
    if ((mime === "image/jpeg" && !jpeg) || (mime === "image/png" && !png) || (mime === "image/webp" && !webp)) return null;
    return bytes;
  } catch { return null; }
}

async function signedUrl(db: SupabaseClient, path: string): Promise<string> {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) throw new Error("IMAGE_EDIT_SIGNING_FAILED");
  return data.signedUrl;
}

export async function handleImageEditApi(
  db: SupabaseClient, userId: string, action: string, body: Record<string, unknown> | null,
  jobId: string, cors: HeadersInit,
): Promise<Response> {
  if (action === "image_edit_quota") {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await db.from("armex_image_edit_daily_usage")
      .select("edits_used").eq("user_id", userId).eq("usage_date", today).maybeSingle();
    if (error) return fail("سهمیه ویرایش تصویر در دسترس نیست؛ مهاجرت پایگاه داده هنوز اعمال نشده است.", 503, cors);
    const used = Number(data?.edits_used || 0);
    return json({ success: true, used, limit: 5, remaining: Math.max(0, 5 - used), resets_at: new Date(Date.UTC(
      new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1,
    )).toISOString() }, 200, cors);
  }

  if (action === "image_edit_status" || action === "image_edits") {
    let query = db.from("armex_image_edit_jobs")
      .select("id,request_id,prompt,status,error_code,created_at,completed_at,input_storage_path,output_storage_path")
      .eq("user_id", userId);
    if (action === "image_edit_status") {
      if (!validUuid(jobId)) return fail("شناسه درخواست معتبر نیست.", 400, cors);
      query = query.eq("id", jobId);
    } else query = query.order("created_at", { ascending: false }).limit(20);
    const { data, error } = await query;
    if (error) return fail("تاریخچه ویرایش تصویر بارگذاری نشد.", 500, cors);
    const rows = action === "image_edit_status" ? (data?.[0] ? [data[0]] : []) : (data || []);
    if (action === "image_edit_status" && !rows.length) return fail("درخواست ویرایش پیدا نشد.", 404, cors);
    const items = await Promise.all(rows.map(async (row) => ({
      id: row.id, request_id: row.request_id, prompt: row.prompt, status: row.status,
      error_code: row.error_code, created_at: row.created_at, completed_at: row.completed_at,
      input_url: await signedUrl(db, row.input_storage_path).catch(() => null),
      image_url: row.output_storage_path ? await signedUrl(db, row.output_storage_path).catch(() => null) : null,
    })));
    return json(action === "image_edit_status" ? { success: true, job: items[0] } : { success: true, edits: items }, 200, cors);
  }

  if (action !== "edit_image" || !body) return fail("عملیات ویرایش تصویر نامعتبر است.", 400, cors);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const requestId = validUuid(body.request_id) ? body.request_id : "";
  const mime = typeof body.mime_type === "string" ? body.mime_type : "";
  const encoded = typeof body.image_base64 === "string" ? body.image_base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "") : "";
  if (!prompt || prompt.length > 1600) return fail("پرامپت باید بین ۱ تا ۱۶۰۰ نویسه باشد.", 400, cors);
  if (!requestId) return fail("شناسه یکتای درخواست معتبر نیست.", 400, cors);

  const { data: prior, error: priorError } = await db.from("armex_image_edit_jobs")
    .select("id,status").eq("user_id", userId).eq("request_id", requestId).maybeSingle();
  if (priorError) return fail("وضعیت درخواست قبلی بررسی نشد.", 500, cors);
  if (prior) return json({ success: true, duplicate: true, job: { id: prior.id, status: prior.status }, model: MODEL }, 202, cors);

  const bytes = decodeImage(encoded, mime);
  if (!bytes) return fail("فایل تصویر معتبر نیست یا حجم آن بیشتر از ۵ مگابایت است. فرمت‌های JPG، PNG و WebP پشتیبانی می‌شوند.", 400, cors);
  const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const path = userId + "/edit/" + requestId + "-input." + extension;
  const { error: uploadError } = await db.storage.from(BUCKET).upload(path, bytes, {
    contentType: mime, upsert: false, cacheControl: "3600",
  });
  if (uploadError) {
    console.error("Image edit input upload failed", { code: uploadError.name || "storage_error" });
    return fail("ذخیره امن تصویر ورودی انجام نشد.", 503, cors);
  }

  const { data, error } = await db.rpc("armex_enqueue_image_edit", {
    p_user_id: userId, p_request_id: requestId, p_prompt: prompt, p_input_storage_path: path,
  });
  if (error || !data) {
    // A transport error can be ambiguous: the transaction may have committed.
    // Keep the source object unless Postgres definitively reports a missing schema/function.
    if (error?.code === "PGRST202" || error?.code === "42P01" || error?.code === "42883") {
      await db.storage.from(BUCKET).remove([path]);
    }
    console.error("Image edit enqueue failed", { code: error?.code });
    return fail("ثبت درخواست ویرایش انجام نشد. ابتدا migration مربوط به ویرایش تصویر باید روی Supabase اعمال شود یا وضعیت درخواست بررسی شود.", 503, cors);
  }
  if (data.success !== true) {
    await db.storage.from(BUCKET).remove([path]);
    if (data.code === "daily_quota_exceeded") {
      return json({ success: false, code: "daily_quota_exceeded", error: "سهمیه رایگان امروزت تمام شده است.", used: data.used, limit: 5 }, 429, cors);
    }
    return fail("درخواست ویرایش در صف ثبت نشد.", 500, cors);
  }
  return json({
    success: true, duplicate: data.duplicate === true,
    job: { id: data.job_id, status: data.status || "queued" },
    quota: { used: data.used ?? null, limit: 5 }, model: MODEL, credits_charged: 0,
  }, 202, cors);
}
