const MODEL_LABEL = "FLUX.2 Klein 4B";
const STYLE_ID = "lokal-image-editor-styles";

export function initImageEditor({ supabase, callArmexApi }) {
  const main = document.querySelector("#workspace-app .main");
  if (!main || document.getElementById("page-image-editor")) return;
  const page = document.createElement("section");
  page.className = "page";
  page.id = "page-image-editor";
  page.innerHTML = `
    <div class="welcome"><div class="eyebrow">LOKAL AI · IMAGE EDITOR</div><h1>ویرایش هوشمند تصویر</h1>
      <p class="muted-copy">عکس را وارد کن، تغییر دلخواهت را توضیح بده و نسخه ویرایش‌شده را دریافت کن. موتور تا حد ممکن سوژه و جزئیات ناخواسته را حفظ می‌کند.</p></div>
    <div class="ie-shell">
      <div class="ie-topline"><div><strong>استودیوی ویرایش تصویر</strong><small>بدون مصرف اعتبار کیف پول · ۵ ویرایش رایگان در روز</small></div>
        <div class="ie-quota"><span id="ie-quota-label">در حال بررسی سهمیه…</span><div class="ie-meter"><i id="ie-quota-meter"></i></div></div></div>
      <div class="ie-grid">
        <div class="ie-input-panel">
          <label class="ie-label" for="ie-file">۱. تصویر اصلی</label>
          <label class="ie-upload" id="ie-upload" for="ie-file"><input id="ie-file" type="file" accept="image/jpeg,image/png,image/webp">
            <span class="ie-upload-icon">＋</span><b>انتخاب تصویر</b><small>JPG، PNG یا WebP · حداکثر ۵ مگابایت پس از آماده‌سازی</small>
            <img id="ie-source-preview" alt="پیش‌نمایش تصویر اصلی" hidden></label>
          <label class="ie-label" for="ie-prompt">۲. دقیقاً چه تغییری می‌خواهی؟</label>
          <textarea id="ie-prompt" class="textarea ie-prompt" maxlength="1600" placeholder="مثلاً: پس‌زمینه را کاملاً سفید کن، نور و سایه طبیعی بماند و تمام جزئیات سوژه بدون تغییر حفظ شود."></textarea>
          <div class="ie-preserve">راهنما: فقط تغییر موردنظر را بنویس و مشخص کن چه چیزهایی باید بدون تغییر بمانند.</div>
          <button class="btn ie-submit" id="ie-submit" type="button" disabled>شروع ویرایش رایگان</button>
          <p class="ie-status" id="ie-status" role="status" aria-live="polite">برای شروع یک تصویر انتخاب کن.</p>
        </div>
        <div class="ie-result-panel">
          <div class="ie-label">۳. نتیجه و مقایسه</div>
          <div class="ie-comparison" id="ie-comparison"><div class="ie-empty"><span>✧</span><b>نتیجه ویرایش اینجا نمایش داده می‌شود</b><small>تصویر اصلی و خروجی را کنار هم مقایسه کن.</small></div></div>
          <div class="ie-result-actions" id="ie-result-actions" hidden>
            <button class="btn btn-ghost btn-small" id="ie-download" type="button">دانلود خروجی</button>
            <button class="btn btn-ghost btn-small" id="ie-next-stage" type="button">ویرایش مرحله بعد با همین خروجی</button>
          </div>
        </div>
      </div>
      <div class="ie-history-wrap"><div class="ie-history-head"><strong>تاریخچه ویرایش‌ها</strong><button class="btn btn-ghost btn-small" id="ie-refresh-history" type="button">به‌روزرسانی</button></div><div class="ie-history" id="ie-history"><small>تاریخچه پس از ورود بارگذاری می‌شود.</small></div></div>
      <small class="ie-footnote">مدل: ${MODEL_LABEL} · سهمیه روزانه به وقت UTC بازنشانی می‌شود. اگر سهمیه رایگان مشترک Cloudflare تمام شود، پردازش متوقف می‌شود و به سرویس پولی دیگری منتقل نخواهد شد.</small>
    </div>`;
  main.append(page);

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #page-image-editor{color:#e9f5f7}
      #page-image-editor .ie-shell{border:1px solid #24404a;border-radius:22px;padding:20px;background:linear-gradient(145deg,#0c151b,#0a1015 65%,#0b171b);box-shadow:0 18px 50px #0005}
      #page-image-editor .ie-topline,#page-image-editor .ie-history-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}
      #page-image-editor .ie-topline strong,#page-image-editor .ie-history-head strong{display:block;font-size:14px}
      #page-image-editor .ie-topline small{display:block;color:#8ba2aa;font-size:10px;margin-top:5px}
      #page-image-editor .ie-quota{width:min(240px,45%);font-size:10px;color:#9dc1c9;text-align:left}
      #page-image-editor .ie-meter{height:6px;background:#1a2a31;border-radius:9px;margin-top:7px;overflow:hidden}
      #page-image-editor .ie-meter i{display:block;height:100%;width:0;background:linear-gradient(90deg,#20b8d5,#69e5c2);border-radius:9px;transition:width .25s}
      #page-image-editor .ie-grid{display:grid;grid-template-columns:minmax(0,.92fr) minmax(0,1.08fr);gap:18px}
      #page-image-editor .ie-input-panel,#page-image-editor .ie-result-panel{min-width:0;border:1px solid #1c343e;border-radius:16px;padding:16px;background:#0b1319}
      #page-image-editor .ie-label{display:block;font-size:11px;font-weight:700;color:#d5edf1;margin:0 0 10px}
      #page-image-editor .ie-upload{position:relative;display:flex;min-height:190px;flex-direction:column;align-items:center;justify-content:center;gap:7px;border:1px dashed #3b6875;border-radius:14px;background:#0e1c23;cursor:pointer;overflow:hidden;text-align:center;padding:12px;margin-bottom:18px}
      #page-image-editor .ie-upload input{position:absolute;width:1px;height:1px;opacity:0}
      #page-image-editor .ie-upload-icon{font-size:28px;color:#62d9d0}
      #page-image-editor .ie-upload b{font-size:12px}
      #page-image-editor .ie-upload small{font-size:9px;color:#829ba4}
      #page-image-editor #ie-source-preview{display:block;max-width:100%;max-height:250px;object-fit:contain;border-radius:10px}
      #page-image-editor .ie-prompt{min-height:125px;resize:vertical;background:#101d23;border-color:#29434b;color:#e7f3f4}
      #page-image-editor .ie-preserve{font-size:9px;line-height:1.9;color:#88a6af;margin:7px 0 13px}
      #page-image-editor .ie-submit{width:100%;background:linear-gradient(100deg,#087f91,#116c73);border:1px solid #2b9aa5;color:#fff}
      #page-image-editor .ie-submit:disabled{opacity:.45;cursor:not-allowed}
      #page-image-editor .ie-status{font-size:10px;line-height:1.9;color:#9bb9c1;min-height:24px;margin:10px 0 0}
      #page-image-editor .ie-comparison{min-height:355px;display:grid;grid-template-columns:1fr 1fr;gap:9px}
      #page-image-editor .ie-comparison figure{margin:0;min-width:0;border:1px solid #20343d;border-radius:12px;overflow:hidden;background:#0b171c}
      #page-image-editor .ie-comparison figure img{display:block;width:100%;height:300px;object-fit:contain;background:#071015}
      #page-image-editor .ie-comparison figcaption{padding:9px;font-size:10px;color:#a8c3ca;text-align:center}
      #page-image-editor .ie-empty{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;border:1px dashed #29434b;border-radius:14px;color:#8ba4ac;text-align:center;padding:25px}
      #page-image-editor .ie-empty span{font-size:34px;color:#4ac7c9}
      #page-image-editor .ie-empty b{font-size:12px}
      #page-image-editor .ie-empty small{font-size:9px}
      #page-image-editor .ie-result-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
      #page-image-editor .ie-history-wrap{border-top:1px solid #1d343c;margin-top:20px;padding-top:18px}
      #page-image-editor .ie-history{display:grid;grid-template-columns:repeat(auto-fill,minmax(115px,1fr));gap:10px}
      #page-image-editor .ie-history-card{border:1px solid #203a44;border-radius:11px;background:#0b151b;padding:7px;color:#d8e9ec;cursor:pointer;text-align:right}
      #page-image-editor .ie-history-card img{width:100%;height:90px;object-fit:cover;border-radius:7px;background:#071015}
      #page-image-editor .ie-history-card small{display:block;font-size:9px;line-height:1.6;color:#9bb4bb;margin-top:6px;max-height:42px;overflow:hidden}
      #page-image-editor .ie-footnote{display:block;color:#76919a;font-size:9px;line-height:1.9;margin-top:15px}
      @media(max-width:800px){#page-image-editor .ie-grid{grid-template-columns:1fr}#page-image-editor .ie-comparison{min-height:240px}#page-image-editor .ie-comparison figure img{height:210px}}
      @media(max-width:430px){#page-image-editor .ie-shell{padding:12px}#page-image-editor .ie-topline{align-items:flex-start;flex-direction:column}#page-image-editor .ie-quota{width:100%;text-align:right}#page-image-editor .ie-input-panel,#page-image-editor .ie-result-panel{padding:11px}#page-image-editor .ie-comparison{grid-template-columns:1fr 1fr;gap:6px}#page-image-editor .ie-comparison figure img{height:165px}}
    `;
    document.head.append(style);
  }

  const $ = (id) => document.getElementById(id);
  const fileInput = $("ie-file"), sourcePreview = $("ie-source-preview"), promptInput = $("ie-prompt");
  const submit = $("ie-submit"), status = $("ie-status"), quotaLabel = $("ie-quota-label");
  const meter = $("ie-quota-meter"), comparison = $("ie-comparison"), actions = $("ie-result-actions");
  let selectedFile = null, currentOutputUrl = "", currentInputUrl = "", activeJob = false;
  let quotaRemaining = 0;

  const getSession = async () => (await supabase.auth.getSession()).data.session;
  const say = (message, bad = false) => { status.textContent = message; status.style.color = bad ? "#ff9c9c" : "#9bb9c1"; };
  const updateQuota = async () => {
    const session = await getSession();
    if (!session) { quotaLabel.textContent = "برای مشاهده سهمیه وارد حساب شو"; meter.style.width = "0%"; return; }
    try {
      const q = await callArmexApi(session, "?action=image_edit_quota");
      quotaRemaining = Number(q.remaining || 0);
      quotaLabel.textContent = `سهمیه امروز: ${q.used}/${q.limit} · ${quotaRemaining} باقی‌مانده`;
      meter.style.width = Math.min(100, Number(q.used || 0) / 5 * 100) + "%";
      if (!quotaRemaining) say("سهمیه رایگان امروز تمام شده است؛ سهمیه بعد از بازنشانی UTC دوباره فعال می‌شود.");
      refreshButton();
    } catch (error) {
      quotaLabel.textContent = "سهمیه هنوز آماده نیست";
      say(error.message || "خواندن سهمیه ناموفق بود.", true);
    }
  };
  const refreshButton = () => { submit.disabled = activeJob || !selectedFile || !promptInput.value.trim() || quotaRemaining <= 0; };
  const makePreview = (file) => {
    if (currentInputUrl) URL.revokeObjectURL(currentInputUrl);
    currentInputUrl = URL.createObjectURL(file);
    sourcePreview.src = currentInputUrl; sourcePreview.hidden = false;
    $("ie-upload").querySelector(".ie-upload-icon").hidden = true;
    $("ie-upload").querySelector("b").textContent = file.name || "تصویر انتخاب‌شده";
  };
  const prepareImage = async (file) => {
    if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("فرمت تصویر باید JPG، PNG یا WebP باشد.");
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob || blob.size > 5 * 1024 * 1024) throw new Error("حجم تصویر آماده‌شده باید کمتر از ۵ مگابایت باشد.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { image_base64: btoa(binary), mime_type: "image/jpeg" };
  };
  const showComparison = (inputUrl, outputUrl) => {
    comparison.innerHTML = "";
    for (const [label, url] of [["تصویر اصلی", inputUrl], ["خروجی ویرایش‌شده", outputUrl]]) {
      const figure = document.createElement("figure"), img = document.createElement("img"), caption = document.createElement("figcaption");
      img.src = url; img.alt = label; caption.textContent = label; figure.append(img, caption); comparison.append(figure);
    }
  };
  const loadHistory = async () => {
    const session = await getSession(); if (!session) return;
    const host = $("ie-history"); host.innerHTML = "<small>در حال بارگذاری…</small>";
    try {
      const result = await callArmexApi(session, "?action=image_edits");
      host.innerHTML = "";
      const completed = (result.edits || []).filter((item) => item.status === "completed" && item.image_url);
      if (!completed.length) { host.innerHTML = "<small>هنوز ویرایشی ثبت نشده است.</small>"; return; }
      for (const item of completed) {
        const card = document.createElement("button"); card.type = "button"; card.className = "ie-history-card";
        const img = document.createElement("img"); img.src = item.image_url; img.alt = "خروجی ویرایش";
        const text = document.createElement("small"); text.textContent = item.prompt;
        card.append(img, text); card.addEventListener("click", async () => {
          const response = await fetch(item.image_url); const blob = await response.blob();
          selectedFile = new File([blob], "lokal-edit-stage.jpg", { type: blob.type || "image/jpeg" });
          makePreview(selectedFile); showComparison(item.input_url || item.image_url, item.image_url);
          currentOutputUrl = item.image_url; actions.hidden = false; promptInput.focus(); refreshButton();
          say("خروجی تاریخچه به‌عنوان ورودی مرحله بعد انتخاب شد.");
        });
        host.append(card);
      }
    } catch (error) { host.textContent = error.message || "تاریخچه در دسترس نیست."; }
  };
  const pollJob = async (session, jobId, inputUrl) => {
    const started = Date.now();
    while (Date.now() - started < 240000) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const result = await callArmexApi(session, "?action=image_edit_status&job_id=" + encodeURIComponent(jobId));
      const job = result.job;
      if (job.status === "completed" && job.image_url) {
        currentOutputUrl = job.image_url; showComparison(inputUrl, job.image_url); actions.hidden = false;
        say("ویرایش با موفقیت انجام شد. خروجی در تاریخچه خصوصی ذخیره شد.");
        await loadHistory(); await updateQuota(); return;
      }
      if (job.status === "failed") throw new Error("ویرایش انجام نشد. " + (job.error_code || "لطفاً با پرامپت کوتاه‌تر دوباره تلاش کن."));
      say(job.status === "processing" ? "مدل در حال ویرایش تصویر است…" : "درخواست در صف پردازش قرار دارد…");
    }
    throw new Error("پردازش هنوز تمام نشده است؛ می‌توانی چند لحظه بعد تاریخچه را به‌روزرسانی کنی.");
  };

  fileInput.addEventListener("change", () => {
    selectedFile = fileInput.files?.[0] || null; actions.hidden = true; currentOutputUrl = "";
    if (selectedFile) { makePreview(selectedFile); say("تصویر آماده است. دستور ویرایش را بنویس."); }
    refreshButton();
  });
  promptInput.addEventListener("input", refreshButton);
  submit.addEventListener("click", async () => {
    if (activeJob) return;
    const session = await getSession();
    if (!session) { say("برای استفاده از ویرایشگر ابتدا وارد حساب شو.", true); return; }
    const prompt = promptInput.value.trim();
    if (!selectedFile || !prompt) return;
    activeJob = true; fileInput.disabled = true; promptInput.disabled = true;
    refreshButton(); actions.hidden = true; say("در حال آماده‌سازی امن تصویر…");
    try {
      const prepared = await prepareImage(selectedFile);
      const result = await callArmexApi(session, "", { action: "edit_image", request_id: crypto.randomUUID(), prompt, ...prepared });
      if (!result.success || !result.job?.id) throw new Error(result.error || "ثبت درخواست ویرایش ناموفق بود.");
      quotaRemaining = Math.max(0, quotaRemaining - (result.duplicate ? 0 : 1)); refreshButton();
      await pollJob(session, result.job.id, currentInputUrl);
    } catch (error) { say(error.message || "ویرایش تصویر ناموفق بود.", true); await updateQuota(); }
    finally { activeJob = false; fileInput.disabled = false; promptInput.disabled = false; refreshButton(); }
  });
  $("ie-download").addEventListener("click", async () => {
    if (!currentOutputUrl) return;
    try {
      const response = await fetch(currentOutputUrl);
      if (!response.ok) throw new Error("خروجی برای دانلود در دسترس نیست.");
      const blob = await response.blob(), localUrl = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = localUrl; a.download = "lokal-ai-edited-image.jpg";
      document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(localUrl);
    } catch (error) { say(error.message || "دانلود تصویر ناموفق بود.", true); }
  });
  $("ie-next-stage").addEventListener("click", async () => {
    if (!currentOutputUrl) return;
    try {
      const response = await fetch(currentOutputUrl); const blob = await response.blob();
      selectedFile = new File([blob], "lokal-ai-edit-stage.jpg", { type: blob.type || "image/jpeg" });
      makePreview(selectedFile); actions.hidden = true; promptInput.value = "";
      say("خروجی مرحله قبل برای ویرایش بعدی انتخاب شد. دستور جدید را بنویس.");
      await updateQuota(); refreshButton();
    } catch { say("بارگذاری خروجی برای مرحله بعد انجام نشد.", true); }
  });
  $("ie-refresh-history").addEventListener("click", loadHistory);
  window.addEventListener("lokal:open-image-editor", () => { void updateQuota(); void loadHistory(); });
  window.addEventListener("lokal:clear-private-data", () => {
    selectedFile = null; fileInput.value = ""; sourcePreview.hidden = true; promptInput.value = "";
    comparison.innerHTML = '<div class="ie-empty"><span>✧</span><b>برای شروع یک تصویر انتخاب کن</b></div>';
    $("ie-history").innerHTML = ""; actions.hidden = true; quotaLabel.textContent = "برای مشاهده سهمیه وارد حساب شو"; quotaRemaining = 0; refreshButton();
  });
  void updateQuota(); void loadHistory();
}
