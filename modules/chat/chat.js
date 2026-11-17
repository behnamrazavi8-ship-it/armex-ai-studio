// Smart Chat module with private image/video attachments.
// Auth, API access and wallet refresh are injected by the host application.
export function initSmartChat({ supabase, callArmexApi, loadWalletBalance, ensureSecureApi }) {
  const chatHistoryList = document.getElementById("chat-history-list");
  const chatTranscript = document.getElementById("chat-transcript");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");
  const chatStatus = document.getElementById("chat-status");
  const chatTitle = document.getElementById("chat-title");
  const mediaInput = document.getElementById("chat-media-input");
  const mediaNote = document.getElementById("chat-file-note");
  const mediaPreview = document.getElementById("chat-attachment-preview");
  let activeChatConversationId = null;
  let chatRequestBusy = false;
  let uploadBusy = false;
  let pendingAttachment = null;

  const styleId = "lokal-chat-media-styles";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #chat-media-input{display:none}
      #chat-file-note{display:block;font-size:9px;line-height:1.7;color:#8da8b0;margin-top:6px}
      #chat-attachment-preview{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:8px 0}
      #chat-attachment-preview:empty{display:none}
      .chat-media-preview{display:flex;align-items:center;gap:9px;padding:8px 10px;border:1px solid #28515a;border-radius:12px;background:#0c1b22;max-width:100%}
      .chat-media-preview img{width:64px;height:64px;object-fit:cover;border-radius:8px}
      .chat-media-preview video{width:110px;max-height:75px;border-radius:8px}
      .chat-media-preview a{color:#9cebd8;font-size:10px;overflow-wrap:anywhere}
      .chat-media-remove{border:1px solid #4b3b43;background:#21151b;color:#ffd6dc;border-radius:8px;padding:6px 9px;font-size:10px}
      .chat-message-attachment{margin-top:8px}
      .chat-message-attachment img{display:block;max-width:min(100%,360px);max-height:260px;object-fit:contain;border-radius:10px}
      .chat-message-attachment video{display:block;max-width:min(100%,360px);max-height:260px;border-radius:10px}
      .chat-message-attachment a{color:#9cebd8;font-size:10px}
    `;
    document.head.append(style);
  }

  const setChatStatus = (message, isError = false) => {
    if (!chatStatus) return;
    chatStatus.textContent = message || "";
    chatStatus.style.color = isError ? "#ffb8c2" : "#91aaa9";
  };

  const addChatMessage = (role, content) => {
    const bubble = document.createElement("div");
    bubble.className = "chat-message " + (role === "user" ? "user" : "assistant");
    bubble.textContent = String(content || "");
    chatTranscript.append(bubble);
    chatTranscript.scrollTop = chatTranscript.scrollHeight;
    return bubble;
  };

  const addAttachmentToBubble = (bubble, attachment) => {
    if (!bubble || !attachment?.signed_url) return;
    const wrap = document.createElement("div");
    wrap.className = "chat-message-attachment";
    const link = document.createElement("a");
    link.href = attachment.signed_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = attachment.original_filename || "فایل پیوست";
    if (String(attachment.mime_type || "").startsWith("image/")) {
      const image = document.createElement("img");
      image.src = attachment.signed_url;
      image.alt = attachment.original_filename || "تصویر پیوست";
      image.loading = "lazy";
      wrap.append(image, link);
    } else if (String(attachment.mime_type || "").startsWith("video/")) {
      const video = document.createElement("video");
      video.src = attachment.signed_url;
      video.controls = true;
      video.preload = "metadata";
      wrap.append(video, link);
    } else {
      wrap.append(link);
    }
    bubble.append(wrap);
  };

  const renderChatHistory = (messages, attachments = []) => {
    chatTranscript.replaceChildren();
    if (!messages?.length) {
      const empty = document.createElement("div");
      empty.className = "chat-empty-state";
      const heading = document.createElement("b");
      heading.textContent = "سلام! من دستیار هوشمند LOKAL AI هستم.";
      empty.append(heading, document.createTextNode("سؤال یا ایده‌ات را بنویس تا شروع کنیم."));
      chatTranscript.append(empty);
    } else {
      const bubbles = new Map();
      messages.forEach((item) => {
        const bubble = addChatMessage(item.role, item.content);
        if (item.id) bubbles.set(item.id, bubble);
      });
      const unlinked = [];
      (attachments || []).forEach((attachment) => {
        const bubble = bubbles.get(attachment.message_id);
        if (bubble) addAttachmentToBubble(bubble, attachment);
        else unlinked.push(attachment);
      });
      unlinked.forEach((attachment) => {
        const bubble = addChatMessage("user", "");
        addAttachmentToBubble(bubble, attachment);
      });
    }
    chatTranscript.scrollTop = chatTranscript.scrollHeight;
  };

  const renderPendingAttachment = (attachment) => {
    if (!mediaPreview) return;
    mediaPreview.replaceChildren();
    if (!attachment) return;
    const wrap = document.createElement("div");
    wrap.className = "chat-media-preview";
    if (String(attachment.mime_type).startsWith("image/") && attachment.signed_url) {
      const image = document.createElement("img");
      image.src = attachment.signed_url;
      image.alt = attachment.original_filename;
      wrap.append(image);
    } else {
      const label = document.createElement("span");
      label.textContent = String(attachment.mime_type).startsWith("video/") ? "▶ ویدئو" : "📎 فایل";
      wrap.append(label);
    }
    const name = document.createElement("span");
    name.textContent = attachment.original_filename || "فایل پیوست";
    name.style.cssText = "font-size:10px;color:#c5dadd;overflow-wrap:anywhere";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chat-media-remove";
    remove.textContent = "حذف";
    remove.addEventListener("click", () => {
      pendingAttachment = null;
      if (mediaInput) mediaInput.value = "";
      renderPendingAttachment(null);
      if (mediaNote) mediaNote.textContent = "عکس تا ۲۰ مگابایت · ویدئو تا ۵۰ مگابایت";
    });
    wrap.append(name, remove);
    mediaPreview.append(wrap);
  };

  const isImageEditRequest = (message) => {
    const text = String(message || "").toLowerCase().replace(/[ي]/g, "ی").replace(/[ك]/g, "ک");
    return /(ویرایش|ادیت|تغییر|عوض کن|تبدیل کن|سفید کن|سیاه کن|روشن کن|تیره کن|حذف کن|پاک کن|جایگزین کن|اضافه کن|برش بده|کراپ|روتوش|پس\s*زمینه|بک\s*گراند|background|retouch|\bedit\b|\bremove\b|\breplace\b)/i.test(text);
  };

  const imageBlobToPayload = async (blob) => {
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width * bitmap.height > 40000000) {
      bitmap.close();
      throw new Error("ابعاد تصویر بیش از حد بزرگ است؛ لطفاً نسخه کوچک‌تری انتخاب کن.");
    }
    let prepared = null;
    for (const maxSide of [1024, 768, 640]) {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) continue;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const output = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.86));
      if (output && output.size <= 5 * 1024 * 1024) {
        prepared = output;
        break;
      }
    }
    bitmap.close();
    if (!prepared) throw new Error("آماده‌سازی تصویر برای ویرایش انجام نشد؛ یک تصویر کم‌حجم‌تر انتخاب کن.");
    const bytes = new Uint8Array(await prepared.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { image_base64: btoa(binary), mime_type: "image/webp" };
  };

  const prepareChatImageForEdit = async (attachment) => {
    if (!attachment?.signed_url || !String(attachment.mime_type || "").startsWith("image/")) {
      throw new Error("برای ویرایش، ابتدا یک تصویر معتبر پیوست کن.");
    }
    const response = await fetch(attachment.signed_url, { cache: "no-store" });
    if (!response.ok) throw new Error("دریافت تصویر پیوست برای ویرایش ناموفق بود.");
    return await imageBlobToPayload(await response.blob());
  };

  const runChatImageEdit = async (session, prompt, attachment) => {
    setChatStatus("در حال آماده‌سازی تصویر برای موتور ویرایش…");
    const prepared = await prepareChatImageForEdit(attachment);
    const queued = await callArmexApi(session, "", {
      action: "edit_image",
      request_id: crypto.randomUUID(),
      prompt,
      ...prepared,
    });
    if (queued?.success !== true || !queued?.job?.id) {
      if (queued?.code === "daily_quota_exceeded" || queued?.status === 429) {
        throw new Error("سهمیه رایگان ویرایش تصویر امروز تمام شده است.");
      }
      throw new Error(queued?.error || "ثبت درخواست ویرایش تصویر ناموفق بود.");
    }
    const started = Date.now();
    while (Date.now() - started < 240000) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const status = await callArmexApi(
        session,
        "?action=image_edit_status&job_id=" + encodeURIComponent(queued.job.id)
      );
      const job = status?.job;
      if (status?.success !== true || !job) throw new Error("وضعیت پردازش تصویر دریافت نشد.");
      if (job.status === "completed" && job.image_url) return job.image_url;
      if (job.status === "failed") {
        const code = String(job.error_code || "");
        if (/429|quota|capacity/i.test(code)) {
          throw new Error("ظرفیت رایگان موتور ویرایش تصویر فعلاً در دسترس نیست؛ بعداً دوباره تلاش کن.");
        }
        throw new Error("موتور ویرایش نتوانست تصویر را پردازش کند. لطفاً دوباره تلاش کن.");
      }
      setChatStatus(job.status === "processing"
        ? "موتور هوش مصنوعی در حال ویرایش تصویر است…"
        : "درخواست ویرایش تصویر در صف پردازش است…");
    }
    throw new Error("پردازش تصویر طول کشید؛ نتیجه را از تاریخچه ویرایش تصویر پیگیری کن.");
  };

  const ensureConversation = async (session) => {
    if (activeChatConversationId) return activeChatConversationId;
    const result = await callArmexApi(session, "", {
      action: "create_conversation",
      title: "گفتگوی جدید",
    });
    if (result.success !== true || !result.conversation?.id) {
      throw new Error("ساخت گفتگوی جدید برای پیوست فایل ناموفق بود.");
    }
    activeChatConversationId = result.conversation.id;
    chatTitle.textContent = result.conversation.title || "گفتگوی جدید";
    await loadChatHistoryList(session);
    return activeChatConversationId;
  };

  const uploadChatAttachment = async (file) => {
    if (uploadBusy || chatRequestBusy) return;
    const allowed = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm", "video/quicktime"];
    if (!allowed.includes(file.type)) {
      setChatStatus("فرمت فایل پشتیبانی نمی‌شود. JPG، PNG، WebP، MP4، WebM و MOV مجازند.", true);
      return;
    }
    const isImage = file.type.startsWith("image/");
    const maxBytes = isImage ? 20 * 1024 * 1024 : 50 * 1024 * 1024;
    if (!file.size || file.size > maxBytes) {
      setChatStatus(isImage ? "حجم تصویر باید حداکثر ۲۰ مگابایت باشد." : "حجم ویدئو باید حداکثر ۵۰ مگابایت باشد.", true);
      return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setChatStatus("برای پیوست فایل ابتدا وارد حساب کاربری شو.", true);
      return;
    }
    uploadBusy = true;
    if (mediaInput) mediaInput.disabled = true;
    try {
      await ensureSecureApi(session);
      const conversationId = await ensureConversation(session);
      if (mediaNote) mediaNote.textContent = "در حال آماده‌سازی آپلود امن…";
      setChatStatus("در حال بارگذاری امن فایل…");
      const upload = await callArmexApi(session, "", {
        action: "create_media_upload",
        conversation_id: conversationId,
        filename: file.name,
        mime_type: file.type,
        size_bytes: file.size,
      });
      if (upload.success !== true || !upload.token || !upload.path || !upload.bucket) {
        throw new Error("لینک امن بارگذاری فایل دریافت نشد.");
      }
      const { error: storageError } = await supabase.storage
        .from(upload.bucket)
        .uploadToSignedUrl(upload.path, upload.token, file, { contentType: file.type, upsert: false });
      if (storageError) throw new Error("بارگذاری فایل ناموفق بود: " + storageError.message);
      const completed = await callArmexApi(session, "", {
        action: "complete_media_upload",
        attachment_id: upload.attachment_id,
      });
      if (completed.success !== true || !completed.attachment?.signed_url) {
        throw new Error(completed.error || "اعتبارسنجی فایل پس از آپلود ناموفق بود.");
      }
      pendingAttachment = completed.attachment;
      renderPendingAttachment(pendingAttachment);
      if (mediaNote) mediaNote.textContent = "فایل با موفقیت و به‌صورت خصوصی بارگذاری شد.";
      setChatStatus("فایل آمادهٔ ارسال همراه پیام است.");
    } catch (error) {
      setChatStatus(String(error?.message || "آپلود فایل ناموفق بود."), true);
      if (mediaNote) mediaNote.textContent = "آپلود کامل نشد؛ فایل را دوباره انتخاب کن.";
    } finally {
      uploadBusy = false;
      if (mediaInput) mediaInput.disabled = false;
    }
  };

  const loadChatHistoryList = async (session) => {
    if (!chatHistoryList || !session) return;
    chatHistoryList.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "empty";
    loading.textContent = "در حال دریافت گفتگوها…";
    chatHistoryList.append(loading);
    try {
      const result = await callArmexApi(session, "?action=conversations");
      chatHistoryList.replaceChildren();
      if (!Array.isArray(result.conversations) || !result.conversations.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "هنوز گفتگویی نداری.";
        chatHistoryList.append(empty);
        return;
      }
      result.conversations.forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chat-history-item" + (item.id === activeChatConversationId ? " active" : "");
        button.dataset.conversationId = item.id;
        button.textContent = item.title || "گفتگوی جدید";
        chatHistoryList.append(button);
      });
    } catch (error) {
      chatHistoryList.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "دریافت تاریخچه ممکن نشد: " + String(error?.message || "خطای سرویس");
      chatHistoryList.append(empty);
    }
  };

  const openChatHistory = async (id, session) => {
    setChatStatus("در حال بارگذاری گفتگو…");
    try {
      const result = await callArmexApi(session, "?action=conversation_messages&id=" + encodeURIComponent(id));
      if (result.success !== true || !Array.isArray(result.messages)) throw new Error("پاسخ تاریخچه معتبر نیست.");
      activeChatConversationId = id;
      pendingAttachment = null;
      renderPendingAttachment(null);
      if (mediaInput) mediaInput.value = "";
      chatTitle.textContent = "گفتگو";
      renderChatHistory(result.messages, result.attachments || []);
      await loadChatHistoryList(session);
      setChatStatus("");
    } catch (error) {
      setChatStatus("بارگذاری گفتگو انجام نشد: " + String(error?.message || error), true);
    }
  };

  const sendChatMessage = async () => {
    const message = chatInput?.value?.trim() || "";
    if ((!message && !pendingAttachment) || chatRequestBusy || uploadBusy) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setChatStatus("برای استفاده از چت ابتدا وارد حساب کاربری شو.", true);
      return;
    }
    chatRequestBusy = true;
    chatSend.disabled = true;
    chatInput.disabled = true;
    if (mediaInput) mediaInput.disabled = true;
    try {
      await ensureSecureApi(session);
      const outgoingMessage = message || (pendingAttachment?.mime_type?.startsWith("image/")
        ? "لطفاً این تصویر را بررسی کن."
        : "این ویدئو را به‌عنوان فایل پیوست در نظر بگیر.");
      addChatMessage("user", outgoingMessage);
      if (pendingAttachment) {
        const localBubble = chatTranscript.lastElementChild;
        addAttachmentToBubble(localBubble, pendingAttachment);
      }
      chatInput.value = "";
      setChatStatus("در حال دریافت پاسخ هوش مصنوعی…");
      if (pendingAttachment?.mime_type?.startsWith("image/") && isImageEditRequest(message)) {
        const sourceAttachment = pendingAttachment;
        const outputUrl = await runChatImageEdit(session, message, sourceAttachment);
        const outputBubble = addChatMessage("assistant", "ویرایش تصویر با موفقیت انجام شد. خروجی آماده است:");
        addAttachmentToBubble(outputBubble, {
          signed_url: outputUrl,
          mime_type: "image/jpeg",
          original_filename: "lokal-ai-edited-image.jpg",
        });
        pendingAttachment = null;
        renderPendingAttachment(null);
        if (mediaInput) mediaInput.value = "";
        if (mediaNote) mediaNote.textContent = "تصویر ویرایش‌شده در تاریخچه ویرایش تصویر ذخیره شده است.";
        setChatStatus("ویرایش تصویر کامل شد · بدون مصرف اعتبار چت.");
        await loadChatHistoryList(session);
        return;
      }
      const payload = {
        request_id: crypto.randomUUID(),
        message: outgoingMessage,
        model: "openai/gpt-4o-mini",
        max_tokens: 1200,
      };
      if (activeChatConversationId) payload.conversation_id = activeChatConversationId;
      if (pendingAttachment) payload.attachment_id = pendingAttachment.id;
      const result = await callArmexApi(session, "", payload);
      if (result.pending) {
        pendingAttachment = null;
        renderPendingAttachment(null);
        if (mediaInput) mediaInput.value = "";
        setChatStatus("درخواست برای تطبیق امن وضعیت پردازش و اعتبار نگه داشته شد؛ آن را دوباره ارسال نکن.");
        await loadWalletBalance(session);
        return;
      }
      if (result.success !== true || !result.answer || !result.conversation_id) {
        throw new Error("پاسخ معتبر از سرویس چت دریافت نشد.");
      }
      activeChatConversationId = result.conversation_id;
      addChatMessage("assistant", result.answer);
      pendingAttachment = null;
      renderPendingAttachment(null);
      if (mediaInput) mediaInput.value = "";
      if (mediaNote) mediaNote.textContent = "عکس تا ۲۰ مگابایت · ویدئو تا ۵۰ مگابایت؛ در این نسخه، مدل چت فقط تصاویر را تحلیل می‌کند.";
      chatTitle.textContent = "گفتگو";
      setChatStatus("پاسخ آماده شد · " + Number(result.usage?.credits_charged || 1).toLocaleString("fa-IR") + " اعتبار مصرف شد.");
      await Promise.all([loadWalletBalance(session), loadChatHistoryList(session)]);
    } catch (error) {
      setChatStatus(String(error?.message || "ارسال پیام ناموفق بود."), true);
      await loadWalletBalance(session);
    } finally {
      chatRequestBusy = false;
      chatSend.disabled = false;
      chatInput.disabled = false;
      if (mediaInput) mediaInput.disabled = false;
      chatInput.focus();
    }
  };

  document.getElementById("chat-new")?.addEventListener("click", () => {
    activeChatConversationId = null;
    pendingAttachment = null;
    chatTitle.textContent = "گفتگوی جدید";
    renderChatHistory([]);
    renderPendingAttachment(null);
    if (mediaInput) mediaInput.value = "";
    setChatStatus("");
    chatHistoryList?.querySelectorAll(".chat-history-item").forEach((item) => item.classList.remove("active"));
    chatInput?.focus();
  });
  chatHistoryList?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-conversation-id]");
    if (!button) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (session) await openChatHistory(button.dataset.conversationId, session);
  });
  mediaInput?.addEventListener("change", () => {
    const file = mediaInput.files?.[0];
    if (file) void uploadChatAttachment(file);
  });
  chatSend?.addEventListener("click", sendChatMessage);
  chatInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  });
  document.querySelectorAll('[data-page="chat"]').forEach((button) => button.addEventListener("click", async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) await loadChatHistoryList(session);
  }));
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" && session) void loadChatHistoryList(session);
    if (event === "SIGNED_OUT") {
      activeChatConversationId = null;
      pendingAttachment = null;
      chatHistoryList?.replaceChildren();
      renderChatHistory([]);
      renderPendingAttachment(null);
      setChatStatus("");
    }
  });
  void supabase.auth.getSession().then(({ data: { session } }) => {
    if (session) void loadChatHistoryList(session);
  });
}
