const $ = (selector) => document.querySelector(selector);
const PENDING_KEY = "lokal_ai_alpha_video_pending_v1";
const statusLabels = {
  queued: "در صف ارسال به موتور ویدئو…",
  submitting: "در حال ارسال امن درخواست به Alpha AI…",
  processing: "Wan 2.2 در حال ساخت ویدئو است…",
  submission_unknown: "پاسخ ارسال آلفا نامشخص است؛ برای جلوگیری از درخواست تکراری، ارسال مجدد انجام نمی‌شود.",
  completed: "ویدئو آماده و در تاریخچهٔ گفتگو ذخیره شد.",
  failed: "ساخت ویدئو ناموفق بود؛ اعتبار رزروشده به کیف پول برگشت.",
};

export function initVideoStudio({ supabase, callArmexApi, loadWalletBalance }) {
  const form = $("#video-form");
  const input = $("#video-image");
  const preview = $("#video-image-preview");
  const prompt = $("#video-prompt");
  const cinematic = $("#video-cinematic");
  const status = $("#video-status");
  const submit = $("#video-generate");
  const history = $("#video-history");
  let selectedFile = null;
  let pollingJobId = null;
  let pollController = null;

  const setStatus = (message, error = false) => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", error);
  };

  const currentSession = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("برای ساخت ویدئو ابتدا وارد حساب کاربری شو.");
    return session;
  };

  const createConversation = async (session) => {
    const result = await callArmexApi(session, "", { action: "create_conversation", title: "ساخت ویدئو با Wan 2.2" });
    if (!result.success || !result.conversation?.id) throw new Error(result.error || "ساخت گفتگوی ویدئو ناموفق بود.");
    return result.conversation.id;
  };

  const uploadReference = async (session, conversationId, file) => {
    const reservation = await callArmexApi(session, "", {
      action: "create_media_upload",
      conversation_id: conversationId,
      filename: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    });
    if (!reservation.success || !reservation.token) throw new Error(reservation.error || "آماده‌سازی آپلود تصویر ناموفق بود.");
    const { error } = await supabase.storage.from(reservation.bucket)
      .uploadToSignedUrl(reservation.path, reservation.token, file, { contentType: file.type, upsert: false });
    if (error) throw new Error("آپلود تصویر ناموفق بود: " + error.message);
    const finalized = await callArmexApi(session, "", {
      action: "complete_media_upload",
      attachment_id: reservation.attachment_id,
    });
    if (!finalized.success || finalized.attachment?.status !== "ready") {
      throw new Error(finalized.error || "تأیید نهایی تصویر ناموفق بود.");
    }
    return reservation.attachment_id;
  };

  const renderCard = (job) => {
    const card = document.createElement("article");
    card.className = "video-history-card";
    const head = document.createElement("div");
    head.className = "video-history-head";
    const title = document.createElement("strong");
    title.textContent = "Wan 2.2 · " + new Date(job.created_at).toLocaleString("fa-IR");
    const badge = document.createElement("span");
    badge.className = "tag";
    badge.textContent = statusLabels[job.status] || String(job.status || "نامشخص");
    head.append(title, badge);
    const description = document.createElement("p");
    description.textContent = String(job.prompt || "");
    card.append(head, description);

    if (job.status === "completed" && job.video_url) {
      const video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.playsInline = true;
      video.src = job.video_url;
      const download = document.createElement("a");
      download.href = job.video_url;
      download.target = "_blank";
      download.rel = "noopener";
      download.textContent = "باز کردن / ذخیره ویدئو";
      card.append(video, download);
    } else if (job.status === "processing" && Number.isInteger(job.progress_percent)) {
      const progress = document.createElement("progress");
      progress.max = 100;
      progress.value = job.progress_percent;
      const progressLabel = document.createElement("small");
      progressLabel.textContent = Number(job.progress_percent).toLocaleString("fa-IR") + "٪";
      card.append(progress, progressLabel);
    } else if (["queued", "submitting", "processing"].includes(job.status)) {
      const track = document.createElement("div");
      track.className = "video-indeterminate";
      track.setAttribute("aria-label", "در حال پردازش");
      card.append(track);
    }

    if (job.status === "submission_unknown") {
      const note = document.createElement("small");
      note.textContent = "درخواست جدید نفرست؛ ابتدا شناسهٔ درخواست باید با فهرست آلفا تطبیق داده شود.";
      card.append(note);
    }
    return card;
  };

  const loadHistory = async (session) => {
    if (!history) return;
    history.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "empty";
    loading.textContent = "در حال دریافت تاریخچهٔ ویدئو…";
    history.append(loading);
    try {
      const result = await callArmexApi(session, "?action=alpha_video_history");
      history.replaceChildren();
      if (!Array.isArray(result.jobs) || !result.jobs.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "هنوز ویدئویی نساخته‌ای.";
        history.append(empty);
        return;
      }
      result.jobs.forEach((job) => history.append(renderCard(job)));
    } catch (error) {
      history.replaceChildren();
      const failed = document.createElement("div");
      failed.className = "empty";
      failed.textContent = String(error?.message || "تاریخچه ویدئو در دسترس نیست.");
      history.append(failed);
    }
  };

  const pollJob = async (session, jobId) => {
    if (pollingJobId === jobId) return;
    pollingJobId = jobId;
    pollController?.abort();
    pollController = new AbortController();
    try {
      for (let attempt = 0; attempt < 330; attempt++) {
        if (pollController.signal.aborted) return;
        const result = await callArmexApi(session, "?action=alpha_video_status&job_id=" + encodeURIComponent(jobId));
        if (!result.success || !result.job) throw new Error(result.error || "وضعیت ویدئو دریافت نشد.");
        const job = result.job;
        setStatus(statusLabels[job.status] || "در حال پیگیری وضعیت ویدئو…");
        if (job.status === "completed") {
          try { localStorage.removeItem(PENDING_KEY); } catch {}
          await loadHistory(session);
          await loadWalletBalance(session);
          return;
        }
        if (job.status === "failed") {
          try { localStorage.removeItem(PENDING_KEY); } catch {}
          await loadHistory(session);
          await loadWalletBalance(session);
          return;
        }
        if (job.status === "submission_unknown") {
          await loadHistory(session);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      setStatus("ساخت همچنان در پس‌زمینه ادامه دارد؛ با بازکردن دوبارهٔ استودیو می‌توانی وضعیت را پیگیری کنی.");
    } catch (error) {
      setStatus(String(error?.message || "پیگیری ویدئو موقتاً ناموفق بود؛ درخواست در سرور باقی می‌ماند."), true);
    } finally {
      if (pollingJobId === jobId) pollingJobId = null;
    }
  };

  input?.addEventListener("change", () => {
    const file = input.files?.[0] || null;
    selectedFile = file;
    if (!file) {
      if (preview) { preview.hidden = true; preview.removeAttribute("src"); }
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size <= 0 || file.size > 20 * 1024 * 1024) {
      selectedFile = null;
      input.value = "";
      if (preview) preview.hidden = true;
      setStatus("تصویر باید JPG، PNG یا WebP و حداکثر ۲۰ مگابایت باشد.", true);
      return;
    }
    if (preview) {
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
    }
    setStatus("تصویر شروع ویدئو آماده است.");
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit?.disabled) return;
    const text = prompt?.value?.trim() || "";
    if (!selectedFile) return setStatus("ابتدا تصویر شروع ویدئو را انتخاب کن.", true);
    if (!text || text.length > 1800) return setStatus("توضیح حرکت باید بین ۱ تا ۱۸۰۰ نویسه باشد.", true);
    submit.disabled = true;
    try {
      const session = await currentSession();
      setStatus("مرحله ۱ از ۳ · ساخت گفتگوی خصوصی…");
      const conversationId = await createConversation(session);
      setStatus("مرحله ۲ از ۳ · آپلود و تأیید امن تصویر…");
      const attachmentId = await uploadReference(session, conversationId, selectedFile);
      setStatus("مرحله ۳ از ۳ · ثبت درخواست و رزرو اعتبار…");
      const result = await callArmexApi(session, "", {
        action: "create_alpha_video",
        request_id: crypto.randomUUID(),
        conversation_id: conversationId,
        attachment_id: attachmentId,
        prompt: text,
        cinematic: cinematic?.checked !== false,
      });
      if (!result.success || !result.job?.id) throw new Error(result.error || "ثبت درخواست ویدئو ناموفق بود.");
      try { localStorage.setItem(PENDING_KEY, result.job.id); } catch {}
      setStatus("درخواست ثبت شد؛ " + Number(result.credits_reserved || 0).toLocaleString("fa-IR") + " اعتبار رزرو شد. Worker پردازش را در پس‌زمینه ادامه می‌دهد.");
      await loadWalletBalance(session);
      await loadHistory(session);
      void pollJob(session, result.job.id);
    } catch (error) {
      setStatus(String(error?.message || "ساخت ویدئو آغاز نشد."), true);
    } finally {
      submit.disabled = false;
    }
  });

  window.addEventListener("lokal:open-video-studio", async () => {
    try {
      const session = await currentSession();
      await loadHistory(session);
      let pending = "";
      try { pending = localStorage.getItem(PENDING_KEY) || ""; } catch {}
      if (pending) void pollJob(session, pending);
    } catch (error) {
      setStatus(String(error?.message || "برای استفاده از استودیوی ویدئو وارد حساب شو."), true);
    }
  });
}
