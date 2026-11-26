const safeText=(value)=>String(value??"");
export function initPromptLab(){
 const page=document.getElementById("page-prompt");
 const builder=document.getElementById("prompt-builder");
 if(!page||!builder||page.dataset.promptFactoryUi==="v1")return;
 page.dataset.promptFactoryUi="v1";
 const welcome=page.querySelector(".welcome");
 const title=welcome?.querySelector("h1");
 if(title)title.textContent="کارخانه پرامپت";
 const description=welcome?.querySelector("p");
 if(description)description.textContent="ایده را تحلیل کن، محدودیت‌ها را حفظ کن و خروجی ساختاریافته و آماده استفاده در استودیوهای LOKAL AI بساز.";
 const nav=document.querySelector('.sidebar [data-page="prompt"]');
 if(nav)nav.innerHTML="✦　کارخانه پرامپت";
 const dashboardCard=document.querySelector('#page-home .app-tool[data-go="prompt"]');
 if(dashboardCard){const h=dashboardCard.querySelector("h4");if(h)h.textContent="کارخانه پرامپت";const p=dashboardCard.querySelector("p");if(p)p.textContent="تحلیل و آماده‌سازی هوشمند پرامپت برای استودیوها";}
 const shell=document.createElement("section");
 shell.className="prompt-factory-shell";
 shell.innerHTML='<div class="prompt-factory-head"><div><div class="prompt-factory-kicker">LOKAL AI · PROMPT INTELLIGENCE WORKSPACE</div><h2>میزکار هوشمند پرامپت</h2><p>از یک ایده خام تا دستور دقیق و قابل انتقال؛ متن اصلی، محدودیت‌ها و مشخصات خروجی را در یک فضای کاری مدیریت کن.</p></div><span class="prompt-factory-state">نسخه یکپارچه · پیش‌نمایش</span></div>';
 const layout=document.createElement("div");
 layout.className="prompt-factory-layout";
 const main=document.createElement("div");main.className="prompt-factory-main";
 const side=document.createElement("aside");side.className="prompt-factory-side";
 side.innerHTML='<section class="factory-side-card"><h3>پیش‌نمایش خروجی نهایی</h3><div class="factory-preview" id="factory-prompt-preview">پس از ساخت یا تحلیل پرامپت، خروجی اینجا نمایش داده می‌شود.</div><div class="factory-actions"><button class="btn btn-ghost" id="factory-copy-prompt" type="button">کپی پرامپت</button><button class="btn" id="factory-send-image" type="button">ارسال به Image Studio</button></div></section><section class="factory-side-card"><h3>ساختار معنایی (Semantic IR)</h3><p>ساختار استاندارد، مستقل از موتور تولید؛ برای بررسی حفظ خواسته‌ها و محدودیت‌ها.</p><pre class="factory-ir" id="factory-ir-preview">هنوز داده ساختاریافته‌ای دریافت نشده است.</pre><div class="factory-actions"><button class="btn btn-ghost" id="factory-copy-ir" type="button" disabled>کپی ساختار JSON</button></div></section><section class="factory-side-card"><h3>پروژه‌های اخیر</h3><div class="factory-recent" id="factory-recent-list"><div class="factory-empty">پروژه ذخیره‌شده‌ای وجود ندارد.</div></div></section><section class="factory-side-card factory-engine-card"><h3>وضعیت موتور هوشمند</h3><div class="factory-engine-note" id="factory-engine-status">موتور فهم معنایی در محیط Staging نگهداری می‌شود. این رابط به‌تنهایی هیچ تصویر یا ویدئویی تولید نمی‌کند و اعتباری مصرف نمی‌کند؛ اتصال احرازشده و آزمون نهایی موتور جداگانه لازم است.</div></section>';
 const parent=builder.parentNode;
 parent.insertBefore(shell,builder);
 parent.insertBefore(layout,builder);
 main.append(builder);
 layout.append(main,side);
 const promptPreview=document.getElementById("factory-prompt-preview");
 const irPreview=document.getElementById("factory-ir-preview");
 const copyPrompt=document.getElementById("factory-copy-prompt");
 const copyIr=document.getElementById("factory-copy-ir");
 const sendImage=document.getElementById("factory-send-image");
 const recentList=document.getElementById("factory-recent-list");
 const result=document.getElementById("promptResult");
 const idea=document.getElementById("idea");
 const copy=async value=>{try{await navigator.clipboard.writeText(value);return true}catch{const t=document.createElement("textarea");t.value=value;document.body.append(t);t.select();let ok=false;try{ok=document.execCommand("copy")}catch{}t.remove();return ok}};
 const currentPrompt=()=>safeText(result?.textContent).trim();
 const syncPrompt=()=>{const value=currentPrompt();if(value)promptPreview.textContent=value};
 const renderRecent=()=>{
  let items=[];try{items=JSON.parse(localStorage.getItem("lokal_ai_projects_v2")||"[]")}catch{}
  recentList.replaceChildren();
  if(!Array.isArray(items)||!items.length){const empty=document.createElement("div");empty.className="factory-empty";empty.textContent="پروژه‌ای ذخیره نشده است.";recentList.append(empty);return}
  items.slice(0,4).forEach(item=>{const button=document.createElement("button");button.type="button";button.className="factory-recent-item";const strong=document.createElement("strong");strong.textContent=safeText(item.title||"پروژه بدون عنوان");const span=document.createElement("span");span.textContent=safeText(item.prompt||"");button.append(strong,span);button.addEventListener("click",()=>{if(idea)idea.value=safeText(item.prompt);promptPreview.textContent=safeText(item.prompt||"");});recentList.append(button)});
 };
 copyPrompt?.addEventListener("click",async()=>{const value=currentPrompt()||promptPreview.textContent;if(!value||value.startsWith("پس از ساخت"))return;const ok=await copy(value);copyPrompt.textContent=ok?"کپی شد":"کپی ممکن نشد";setTimeout(()=>copyPrompt.textContent="کپی پرامپت",1600)});
 copyIr?.addEventListener("click",async()=>{const value=irPreview.textContent;if(!value||value.startsWith("هنوز"))return;const ok=await copy(value);copyIr.textContent=ok?"کپی شد":"کپی ممکن نشد";setTimeout(()=>copyIr.textContent="کپی ساختار JSON",1600)});
 sendImage?.addEventListener("click",()=>{const value=currentPrompt()||promptPreview.textContent;if(!value||value.startsWith("پس از ساخت"))return;const target=document.getElementById("imagePrompt");if(target)target.value=value.slice(0,2048);window.lokalShowPage?.("image");});
 document.getElementById("generatePrompt")?.addEventListener("click",()=>setTimeout(syncPrompt,0));
 document.getElementById("generateAIPrompt")?.addEventListener("click",()=>{const status=document.getElementById("aiPromptStatus");if(status)document.getElementById("factory-engine-status").textContent="درخواست تحلیل معنایی ارسال شد؛ نتیجه و وضعیت احراز هویت در همین پنل نمایش داده می‌شود. تحلیل پرامپت نباید اعتبار تولید تصویر یا ویدئو مصرف کند."});
 document.getElementById("savePrompt")?.addEventListener("click",()=>setTimeout(renderRecent,80));
 document.getElementById("clearPrompt")?.addEventListener("click",()=>{promptPreview.textContent="پس از ساخت یا تحلیل پرامپت، خروجی اینجا نمایش داده می‌شود.";irPreview.textContent="هنوز داده ساختاریافته‌ای دریافت نشده است.";copyIr.disabled=true;});
 if(result&&typeof MutationObserver!=="undefined"){new MutationObserver(syncPrompt).observe(result,{childList:true,subtree:true,characterData:true});}
 window.addEventListener("lokal:ai-prompt-result",event=>{
  const detail=event.detail||{};
  if(detail.answer)promptPreview.textContent=safeText(detail.answer);
  if(detail.ir){irPreview.textContent=JSON.stringify(detail.ir,null,2);copyIr.disabled=false;}
  const status=document.getElementById("factory-engine-status");
  if(status&&detail.usage){const usage=detail.usage;status.textContent="تحلیل معنایی انجام شد؛ مدل: "+safeText(usage.model||"نامشخص")+" · توکن ورودی: "+safeText(usage.prompt_tokens??"—")+" · توکن خروجی: "+safeText(usage.completion_tokens??"—")+". این مرحله اعتبار تولید رسانه مصرف نمی‌کند."}
 });
 renderRecent();
}
