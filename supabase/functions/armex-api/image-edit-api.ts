import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "lokal-ai-images";
const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
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
  jobId: string, openRouterKey: string, cors: HeadersInit,
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
      .select("id,request_id,prompt,status,error_code,created_at,completed_at,input_storage_path,input_storage_paths,output_storage_path")
      .eq("user_id", userId);
    if (action === "image_edit_status") {
      if (!validUuid(jobId)) return fail("شناسه درخواست معتبر نیست.", 400, cors);
      query = query.eq("id", jobId);
    } else query = query.order("created_at", { ascending: false }).limit(20);
    const { data, error } = await query;
    if (error) return fail("تاریخچه ویرایش تصویر بارگذاری نشد.", 500, cors);
    const rows = action === "image_edit_status" ? (data?.[0] ? [data[0]] : []) : (data || []);
    if (action === "image_edit_status" && !rows.length) return fail("درخواست ویرایش پیدا نشد.", 404, cors);
    const items = await Promise.all(rows.map(async (row) => {
      const paths = Array.isArray(row.input_storage_paths) && row.input_storage_paths.length
        ? row.input_storage_paths
        : [row.input_storage_path];
      const inputUrls = await Promise.all(paths.map((path: string) => signedUrl(db, path).catch(() => null)));
      return {
        id: row.id, request_id: row.request_id, prompt: row.prompt, status: row.status,
        error_code: row.error_code, created_at: row.created_at, completed_at: row.completed_at,
        input_url: inputUrls[0] || null, input_urls: inputUrls.filter(Boolean),
        image_url: row.output_storage_path ? await signedUrl(db, row.output_storage_path).catch(() => null) : null,
      };
    }));
    return json(action === "image_edit_status" ? { success: true, job: items[0] } : { success: true, edits: items }, 200, cors);
  }

  if (action !== "edit_image" || !body) return fail("عملیات ویرایش تصویر نامعتبر است.", 400, cors);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const requestId = validUuid(body.request_id) ? body.request_id : "";
  const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];
  const rawImages = Array.isArray(body.images)
    ? body.images
    : [{ image_base64: body.image_base64, mime_type: body.mime_type }];
  if (!prompt || prompt.length > 1600) return fail("پرامپت باید بین ۱ تا ۱۶۰۰ نویسه باشد.", 400, cors);
  if (!requestId) return fail("شناسه یکتای درخواست معتبر نیست.", 400, cors);
  if (attachmentIds.length > 3 || attachmentIds.some((id) => !validUuid(id))) {
    return fail("برای ویرایش هم‌زمان باید بین ۱ تا ۳ تصویر معتبر ارسال شود.", 400, cors);
  }
  if (attachmentIds.length && (Array.isArray(body.images) || body.image_base64)) {
    return fail("برای ویرایش، شناسه تصاویر چت را به‌جای داده خام تصویر ارسال کن.", 400, cors);
  }

  const { data: prior, error: priorError } = await db.from("armex_image_edit_jobs")
    .select("id,status").eq("user_id", userId).eq("request_id", requestId).maybeSingle();
  if (priorError) return fail("وضعیت درخواست قبلی بررسی نشد.", 500, cors);
  if (prior) return json({ success: true, duplicate: true, job: { id: prior.id, status: prior.status }, model: MODEL }, 202, cors);

  const today = new Date().toISOString().slice(0, 10);
  const { data: quotaRow, error: quotaError } = await db.from("armex_image_edit_daily_usage")
    .select("edits_used").eq("user_id", userId).eq("usage_date", today).maybeSingle();
  if (quotaError) return fail("سهمیه ویرایش تصویر در دسترس نیست.", 503, cors);
  if (Number(quotaRow?.edits_used || 0) >= 5) {
    return json({ success: false, code: "daily_quota_exceeded", error: "سهمیه رایگان امروزت تمام شده است.", used: 5, limit: 5 }, 429, cors);
  }
  if (!openRouterKey) return fail("هوش معنایی ویرایش تصویر موقتاً در دسترس نیست.", 503, cors);
  let compiledPrompt = "";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(OPENROUTER_URL + "/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + openRouterKey,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://lokal-ai.net",
          "X-Title": "LOKAL AI Image Edit Prompt Compiler",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          temperature: 0.1,
          max_tokens: 500,
          messages: [
            {
              role: "system",
              content: "You compile image-edit instructions for FLUX.2 Klein. Translate Persian or mixed-language instructions into precise English. Preserve exactly what must change and what must remain unchanged, including object identity, count, shape, color, materials, placement, background, perspective, and all negative constraints. Do not add unrequested objects or redesign untouched parts. For multiple reference images, keep their roles distinct and refer to their order only when the user specifies which image supplies which element. Return only the final editing prompt, with no explanation or Markdown."
            },
            { role: "user", content: "Compile this exact image-edit request without changing its meaning:\n\n" + prompt }
          ]
        }),
      });
      if (!response.ok) throw new Error("EDIT_PROMPT_COMPILER_HTTP_" + response.status);
      const result = await response.json();
      const content = result.choices?.[0]?.message?.content;
      compiledPrompt = typeof content === "string"
        ? content.replace(/^\s*```(?:text)?\s*/i, "").replace(/\s*```\s*$/, "").trim()
        : "";
      console.log("Image edit prompt compiled", {
        requestId,
        inputTokens: Number(result.usage?.prompt_tokens || 0),
        outputTokens: Number(result.usage?.completion_tokens || 0),
        providerCostUsd: Number.isFinite(Number(result.usage?.cost)) ? Number(result.usage.cost) : null,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.error("Image edit prompt compilation failed", { requestId, code: String(error?.message || "compiler_error").slice(0, 80) });
    return fail("دستور ویرایش برای موتور تصویر به‌درستی آماده نشد؛ سهمیه‌ای مصرف نشده است. دوباره تلاش کن.", 502, cors);
  }
  if (!compiledPrompt || compiledPrompt.length > 1600) {
    return fail("دستور نهایی ویرایش معتبر نیست؛ سهمیه‌ای مصرف نشده است.", 502, cors);
  }

  const decodedImages: Array<{ bytes: Uint8Array; mime: string; extension: string }> = [];
  if (attachmentIds.length) {
    const conversationId = body.conversation_id;
    if (!validUuid(conversationId)) return fail("شناسه گفتگوی تصاویر معتبر نیست.", 400, cors);
    const { data: attachments, error: attachmentError } = await db.from("armex_chat_attachments")
      .select("id,storage_path,mime_type,status")
      .in("id", attachmentIds as string[]).eq("user_id", userId)
      .eq("conversation_id", conversationId).eq("status", "ready");
    if (attachmentError || !attachments || attachments.length !== attachmentIds.length) {
      return fail("یک یا چند تصویر در گفتگوی فعلی پیدا نشد یا هنوز آماده نیست.", 404, cors);
    }
    const orderedAttachments = (attachmentIds as string[]).map((id) => attachments.find((item) => item.id === id)).filter(Boolean);
    for (let index = 0; index < orderedAttachments.length; index++) {
      const attachment = orderedAttachments[index]!;
      const mime = String(attachment.mime_type || "");
      if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
        return fail("فقط تصاویر JPG، PNG و WebP برای ویرایش پشتیبانی می‌شوند.", 415, cors);
      }
      const { data: file, error: downloadError } = await db.storage.from("lokal-chat-media")
        .download(String(attachment.storage_path));
      if (downloadError || !file || file.size <= 0 || file.size > MAX_INPUT_BYTES) {
        return fail("دریافت تصویر شماره " + (index + 1) + " برای ویرایش ناموفق بود یا حجم آن بیش از ۲۰ مگابایت است.", 413, cors);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const signatureValid = mime === "image/jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : mime === "image/png"
        ? bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        : bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
          String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
      if (!signatureValid) return fail("محتوای تصویر شماره " + (index + 1) + " با فرمت اعلام‌شده مطابقت ندارد.", 415, cors);
      const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
      decodedImages.push({ bytes, mime, extension });
    }
  } else {
    if (!Array.isArray(rawImages) || rawImages.length < 1 || rawImages.length > 3) {
      return fail("برای ویرایش هم‌زمان باید بین ۱ تا ۳ تصویر ارسال شود.", 400, cors);
    }
    for (const raw of rawImages) {
      if (!raw || typeof raw !== "object") return fail("اطلاعات یکی از تصاویر معتبر نیست.", 400, cors);
      const image = raw as Record<string, unknown>;
      const mime = typeof image.mime_type === "string" ? image.mime_type : "";
      const encoded = typeof image.image_base64 === "string"
        ? image.image_base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
        : "";
      if (encoded.length > Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 8) {
        return fail("حجم یکی از تصاویر از سقف مجاز بیشتر است.", 400, cors);
      }
      const bytes = decodeImage(encoded, mime);
      if (!bytes) return fail("یکی از تصاویر معتبر نیست یا حجم آن بیشتر از ۲۰ مگابایت است. فرمت‌های JPG، PNG و WebP پشتیبانی می‌شوند.", 400, cors);
      const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
      decodedImages.push({ bytes, mime, extension });
    }
  }

  const paths: string[] = [];
  for (let index = 0; index < decodedImages.length; index++) {
    const item = decodedImages[index];
    const path = userId + "/edit/" + requestId + "-input-" + index + "." + item.extension;
    const { error: uploadError } = await db.storage.from(BUCKET).upload(path, item.bytes, {
      contentType: item.mime, upsert: true, cacheControl: "3600",
    });
    if (uploadError) {
      if (paths.length) await db.storage.from(BUCKET).remove(paths);
      console.error("Image edit input upload failed", { index, code: uploadError.name || "storage_error" });
      return fail("ذخیره امن تصاویر ورودی انجام نشد.", 503, cors);
    }
    paths.push(path);
  }

  const { data, error } = await db.rpc("armex_enqueue_image_edit_multi", {
    p_user_id: userId, p_request_id: requestId, p_prompt: compiledPrompt, p_input_storage_paths: paths,
  });
  if (error || !data) {
    // A transport error can be ambiguous: the transaction may have committed.
    // Keep the source objects unless Postgres definitively reports a missing schema/function.
    if (error?.code === "PGRST202" || error?.code === "42P01" || error?.code === "42883") {
      await db.storage.from(BUCKET).remove(paths);
    }
    console.error("Image edit enqueue failed", { code: error?.code });
    return fail("ثبت درخواست ویرایش انجام نشد. ابتدا migration چندتصویری باید روی Supabase اعمال شود یا وضعیت درخواست بررسی شود.", 503, cors);
  }
  if (data.duplicate === true) {
    await db.storage.from(BUCKET).remove(paths);
  }
  if (data.success !== true) {
    await db.storage.from(BUCKET).remove(paths);
    if (data.code === "daily_quota_exceeded") {
      return json({ success: false, code: "daily_quota_exceeded", error: "سهمیه رایگان امروزت تمام شده است.", used: data.used, limit: 5 }, 429, cors);
    }
    return fail("درخواست ویرایش در صف ثبت نشد.", 500, cors);
  }
  return json({
    success: true, duplicate: data.duplicate === true,
    job: { id: data.job_id, status: data.status || "queued" },
    quota: { used: data.used ?? null, limit: 5 }, model: MODEL, credits_charged: 0,
    input_count: paths.length,
  }, 202, cors);
}
