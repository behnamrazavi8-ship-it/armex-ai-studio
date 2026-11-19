// Smart Chat UI module for the current LOKAL AI workspace.
// Media uploads use short-lived signed upload tokens issued by armex-api.
export function initSmartChat({ supabase, callArmexApi, loadWalletBalance, ensureSecureApi }) {
 const chatHistoryList=document.getElementById("chat-history-list");
 const chatTranscript=document.getElementById("chat-transcript");
 const chatInput=document.getElementById("chat-input");
 const chatSend=document.getElementById("chat-send");
 const chatStatus=document.getElementById("chat-status");
 const chatTitle=document.getElementById("chat-title");
 const attachButton=document.getElementById("chat-attach");
 const attachmentInput=document.getElementById("chat-attachment-input");
 const attachmentPreview=document.getElementById("chat-attachment-preview");
 const historyDrawer=document.getElementById("chat-history-drawer");
 const historyToggle=document.getElementById("chat-history-toggle");
 const historyClose=document.getElementById("chat-history-close");
 const closeHistoryDrawer=()=>{
  if(historyDrawer)historyDrawer.hidden=true;
  historyToggle?.setAttribute("aria-expanded","false");
 };
 historyToggle?.addEventListener("click",()=>{
  if(!historyDrawer)return;
  historyDrawer.hidden=false;
  historyToggle.setAttribute("aria-expanded","true");
 });
 historyClose?.addEventListener("click",closeHistoryDrawer);
 historyDrawer?.addEventListener("click",event=>{
  if(event.target?.matches?.("[data-chat-history-close]"))closeHistoryDrawer();
 });
 document.addEventListener("click",event=>{
  const nav=event.target?.closest?.("[data-page]");
  if(nav)document.body.classList.toggle("lokal-chat-active",nav.dataset.page==="chat");
 });
 let activeChatConversationId=null;
 let chatRequestBusy=false;
 let selectedImageFiles=[];
 let selectedImageUrls=[];
 let uploadedAttachments=[];
 let lastImageContext=[];

 const style=document.createElement("style");
 style.id="lokal-chat-attachment-styles";
 style.textContent=`
  .chat-workspace{display:grid;grid-template-columns:minmax(220px,.32fr) minmax(0,.68fr);gap:16px;min-height:620px}
  .chat-history-panel,.chat-conversation{min-width:0;padding:16px;border:1px solid var(--border,#263c49);border-radius:18px;background:var(--panel,#0b1218)}
  .chat-history-list{display:flex;flex-direction:column;gap:7px;margin-top:12px;max-height:520px;overflow:auto}
  .chat-history-item{width:100%;padding:11px;text-align:right;border:1px solid transparent;border-radius:10px;background:#101a21;color:inherit;cursor:pointer}
  .chat-history-item.active{border-color:#287d91;background:#10232a}
  .chat-conversation{display:flex;flex-direction:column;min-height:620px}
  .chat-conversation-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:12px;border-bottom:1px solid #20343e}
  .chat-transcript{flex:1;min-height:300px;max-height:560px;overflow:auto;padding:16px 4px}
  .chat-message{max-width:min(88%,680px);padding:12px 14px;margin:8px 0;border:1px solid #263b45;border-radius:14px;background:#101b22;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.9}
  .chat-message.user{margin-right:auto;background:#10242a;border-color:#28505b}
  .chat-message.assistant{margin-left:auto}
  .chat-empty-state{display:grid;gap:8px;place-content:center;min-height:260px;text-align:center;color:#9eb4bd}
  .chat-empty-state b{color:#e1f1f4}
  .chat-compose-box{border:1px solid #29434d;border-radius:14px;padding:12px;background:#0c171d}
  .chat-compose-box textarea{width:100%;min-height:92px;resize:vertical;border:0;outline:0;background:transparent;color:inherit}
  .chat-live-status{min-height:24px;padding:7px 3px;color:#9db5bc;font-size:11px}
  #chat-exit{font-size:11px}
  @media(max-width:760px){.chat-workspace{grid-template-columns:1fr;min-height:0}.chat-history-panel{order:2}.chat-conversation{min-height:560px}.chat-transcript{max-height:420px}.chat-history-list{max-height:180px}}
  .chat-compose-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .chat-compose-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
  #chat-attach{min-height:38px}
  #chat-attachment-preview{display:flex;align-items:center;gap:10px;margin-top:10px;padding:9px;border:1px solid #29404a;border-radius:12px;background:#0b151b}
  #chat-attachment-preview[hidden]{display:none}
  #chat-attachment-preview img{width:58px;height:58px;object-fit:cover;border-radius:8px}
  #chat-attachment-preview span{min-width:0;overflow-wrap:anywhere;font-size:10px;color:#c5d7dc}
  .chat-message-attachment{display:block;max-width:min(260px,100%);max-height:260px;object-fit:contain;border-radius:12px;margin-top:9px;border:1px solid #29404a}
  .chat-attachment-history{display:flex;gap:9px;flex-wrap:wrap;margin:12px 0;padding:10px;border:1px solid #233b44;border-radius:12px}
  .chat-attachment-history a{display:flex;align-items:center;gap:7px;color:#a8e7eb;font-size:10px;text-decoration:none;max-width:100%}
  .chat-attachment-history img{width:54px;height:54px;object-fit:cover;border-radius:8px}
  @media(max-width:560px){.chat-compose-actions{align-items:stretch}.chat-compose-actions .muted-copy{width:100%}.chat-compose-tools{width:100%}#chat-attach{flex:1}}
  .chat-workspace{display:block;height:calc(100dvh - 220px);min-height:0}
  .chat-conversation{height:100%;min-height:0;overflow:hidden}
  .chat-transcript{flex:1;min-height:0;max-height:none;overflow-y:auto;overscroll-behavior:contain}
  .chat-compose-box{flex:0 0 auto}
  .chat-history-drawer{position:fixed;inset:0;z-index:70;display:flex;align-items:stretch;justify-content:flex-start}
  .chat-history-drawer[hidden]{display:none}
  .chat-history-backdrop{position:absolute;inset:0;background:#02070bd9}
  .chat-history-drawer .chat-history-panel{position:relative;z-index:1;width:min(380px,90vw);height:100%;margin:0;border-radius:0 18px 18px 0;overflow:auto}
  .chat-history-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
  .chat-selected-images{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
  .chat-selected-attachment{display:flex;align-items:center;gap:8px;max-width:100%;padding:6px;border:1px solid #29434d;border-radius:10px}
  .chat-selected-attachment img{width:56px;height:56px;object-fit:cover;border-radius:8px}
  .chat-selected-attachment span{font-size:11px;overflow-wrap:anywhere}
  body.lokal-chat-active{overflow:hidden}
  body.lokal-chat-active .app-layout{height:calc(100dvh - 70px);overflow:hidden}
  body.lokal-chat-active .main{height:100%;min-height:0}
  body.lokal-chat-active #page-chat{height:100%;display:flex;flex-direction:column;overflow:hidden}
  body.lokal-chat-active #page-chat .welcome{flex:0 0 auto}
  body.lokal-chat-active #page-chat .chat-workspace{flex:1;min-height:0;height:auto}
  body.lokal-chat-active #page-chat .chat-conversation{min-height:0}
  @media(max-width:760px){
   .chat-workspace{height:calc(100dvh - 190px)}
   body.lokal-chat-active .app-layout{height:calc(100dvh - 62px);padding-bottom:78px}
   body.lokal-chat-active .main{height:100%;min-height:0}
   body.lokal-chat-active #page-chat{min-height:0}
   .chat-history-drawer .chat-history-panel{width:min(340px,88vw);border-radius:0 16px 16px 0}
  }
 `;
 if(!document.getElementById(style.id))document.head.append(style);

 let activeObjectUrls=[];
 const setChatStatus=(message,isError=false)=>{if(!chatStatus)return;chatStatus.textContent=message||"";chatStatus.style.color=isError?"#ffb8c2":"#91aaa9"};
 const addChatMessage=(role,content,attachment=null)=>{
  const bubble=document.createElement("div");
  bubble.className="chat-message "+(role==="user"?"user":"assistant");
  const text=document.createElement("div");text.textContent=String(content||"");bubble.append(text);
  const attachments=Array.isArray(attachment)?attachment:attachment?[attachment]:[];
  attachments.forEach(item=>{
   if(!item?.signed_url||!String(item.mime_type||"").startsWith("image/"))return;
   const image=document.createElement("img");image.className="chat-message-attachment";
   image.src=item.signed_url;image.alt=item.original_filename||"تصویر پیوست‌شده";
   image.loading="lazy";bubble.append(image);
  });
  chatTranscript.append(bubble);chatTranscript.scrollTop=chatTranscript.scrollHeight;
 };
 const renderAttachmentHistory=(attachments=[])=>{
  const ready=(attachments||[]).filter(item=>item?.signed_url&&String(item.mime_type||"").startsWith("image/"));
  if(!ready.length)return;
  const wrap=document.createElement("div");wrap.className="chat-attachment-history";
  ready.forEach(item=>{
   const link=document.createElement("a");link.href=item.signed_url;link.target="_blank";link.rel="noopener";
   const image=document.createElement("img");image.src=item.signed_url;image.alt=item.original_filename||"تصویر پیوست";
   const name=document.createElement("span");name.textContent=item.original_filename||"تصویر پیوست";
   link.append(image,name);wrap.append(link);
  });
  chatTranscript.append(wrap);
 };
 const renderChatHistory=(messages,attachments=[])=>{
  chatTranscript.replaceChildren();
  if(!messages?.length){
   const empty=document.createElement("div");empty.className="chat-empty-state";
   const heading=document.createElement("b");heading.textContent="سلام! من دستیار هوشمند LOKAL AI هستم.";
   empty.append(heading,document.createTextNode("سؤال یا ایده‌ات را بنویس تا شروع کنیم."));
   chatTranscript.append(empty);
  }else messages.forEach(item=>{
   const linked=(attachments||[]).filter(file=>file.message_id===item.id);
   addChatMessage(item.role,item.content,linked);
  });
  renderAttachmentHistory((attachments||[]).filter(file=>!file.message_id));
 };
 const renderSelectedImage=()=>{
  if(!attachmentPreview)return;
  attachmentPreview.replaceChildren();
  if(!selectedImageFiles.length){attachmentPreview.hidden=true;return}
  attachmentPreview.classList.add("chat-selected-images");
  selectedImageFiles.forEach((file,index)=>{
   const item=document.createElement("div");item.className="chat-selected-attachment";
   const image=document.createElement("img");image.src=selectedImageUrls[index];image.alt="پیش‌نمایش تصویر "+(index+1);
   const label=document.createElement("span");label.textContent=(index+1)+". "+file.name+" · "+(file.size/1024/1024).toFixed(1)+" MB";
   item.append(image,label);attachmentPreview.append(item);
  });
  attachmentPreview.hidden=false;
 };
 const clearSelectedImage=()=>{
  activeObjectUrls.forEach(url=>URL.revokeObjectURL(url));activeObjectUrls=[];
  selectedImageFiles=[];selectedImageUrls=[];uploadedAttachments=[];
  if(attachmentInput)attachmentInput.value="";
  renderSelectedImage();
 };
 const loadChatHistoryList=async(session)=>{
  if(!chatHistoryList||!session)return;
  chatHistoryList.replaceChildren();
  const loading=document.createElement("div");loading.className="empty";loading.textContent="در حال دریافت گفتگوها…";chatHistoryList.append(loading);
  try{
   const result=await callArmexApi(session,"?action=conversations");
   chatHistoryList.replaceChildren();
   if(!Array.isArray(result.conversations)||!result.conversations.length){
    const empty=document.createElement("div");empty.className="empty";empty.textContent="هنوز گفتگویی نداری.";chatHistoryList.append(empty);return;
   }
   result.conversations.forEach(item=>{
    const button=document.createElement("button");button.type="button";
    button.className="chat-history-item"+(item.id===activeChatConversationId?" active":"");
    button.dataset.conversationId=item.id;button.textContent=item.title||"گفتگوی جدید";
    chatHistoryList.append(button);
   });
  }catch(error){
   chatHistoryList.replaceChildren();const empty=document.createElement("div");empty.className="empty";
   empty.textContent="دریافت تاریخچه ممکن نشد: "+String(error?.message||"خطای سرویس");
   chatHistoryList.append(empty);
  }
 };
 const openChatHistory=async(id,session)=>{
  setChatStatus("در حال بارگذاری گفتگو…");
  try{
   const result=await callArmexApi(session,"?action=conversation&id="+encodeURIComponent(id));
   if(result.success!==true||!Array.isArray(result.messages))throw new Error("پاسخ تاریخچه معتبر نیست.");
   activeChatConversationId=id;chatTitle.textContent=result.conversation?.title||"گفتگو";
   clearSelectedImage();
   const historicalImages=(result.attachments||[]).filter(item=>item?.signed_url&&String(item.mime_type||"").startsWith("image/"));
   lastImageContext=historicalImages.slice(-3);window.LOKAL_PROMPT_REFERENCE_IMAGE_URL=lastImageContext[0]?.signed_url||"";
   window.LOKAL_PROMPT_REFERENCE_IMAGE_URLS=lastImageContext.map(item=>item.signed_url);
   renderChatHistory(result.messages,result.attachments||[]);
   await loadChatHistoryList(session);setChatStatus("");
  }catch(error){setChatStatus("بارگذاری گفتگو انجام نشد: "+String(error?.message||error),true)}
 };
 const ensureConversationForAttachment=async(session)=>{
  if(activeChatConversationId)return activeChatConversationId;
  const created=await callArmexApi(session,"",{action:"create_conversation",title:"گفتگو با تصویر"});
  if(created.success!==true||!created.conversation?.id)throw new Error("ساخت گفتگوی امن برای بارگذاری تصویر ناموفق بود.");
  activeChatConversationId=created.conversation.id;
  chatTitle.textContent=created.conversation.title||"گفتگو با تصویر";
  await loadChatHistoryList(session);
  return activeChatConversationId;
 };
 const uploadSelectedImages=async(session)=>{
  if(!selectedImageFiles.length)return [];
  const conversationId=await ensureConversationForAttachment(session);
  const completedAttachments=selectedImageFiles.map((_,index)=>uploadedAttachments[index]||null);
  for(let index=0;index<selectedImageFiles.length;index++){
   if(completedAttachments[index])continue;
   const file=selectedImageFiles[index];
   setChatStatus("در حال بارگذاری امن تصویر "+(index+1)+" از "+selectedImageFiles.length+"…");
   const init=await callArmexApi(session,"",{action:"create_media_upload",conversation_id:conversationId,
    mime_type:file.type,filename:file.name,size_bytes:file.size});
   if(init.success!==true||!init.attachment_id||!init.path||!init.token||!init.bucket)throw new Error("آماده‌سازی بارگذاری تصویر "+(index+1)+" ناموفق بود.");
   const {error:uploadError}=await supabase.storage.from(init.bucket).uploadToSignedUrl(
    init.path,init.token,file,{contentType:file.type,cacheControl:"3600"}
   );
   if(uploadError)throw new Error("آپلود تصویر "+(index+1)+" انجام نشد: "+uploadError.message);
   const completed=await callArmexApi(session,"",{action:"complete_media_upload",attachment_id:init.attachment_id});
   if(completed.success!==true||!completed.attachment?.id)throw new Error("تأیید امن تصویر "+(index+1)+" انجام نشد.");
   completedAttachments[index]=completed.attachment;
   uploadedAttachments=completedAttachments.slice();
  }
  window.LOKAL_PROMPT_REFERENCE_IMAGE_URL=completedAttachments[0]?.signed_url||"";
  window.LOKAL_PROMPT_REFERENCE_IMAGE_URLS=completedAttachments.map(item=>item?.signed_url).filter(Boolean);
  window.LOKAL_PROMPT_REFERENCE_IMAGE=null;
  return completedAttachments;
 };

 const isImageEditRequest=(message)=>{
  const text=String(message||"").toLowerCase().replace(/[ي]/g,"ی").replace(/[ك]/g,"ک");
  return /(ویرایش|ادیت|تغییر|عوض کن|تبدیل کن|سفید کن|سیاه کن|روشن کن|تیره کن|حذف کن|پاک کن|جایگزین کن|اضافه کن|برش بده|کراپ|روتوش|اصلاح کن|اصلاحش|درستش کن|پس\s*زمینه|بک\s*گراند|تصویر قبلی|عکس قبلی|خروجی قبلی|همون عکس|همون تصویر|background|retouch|\bedit\b|\bremove\b|\breplace\b)/i.test(text);
 };


 const persistEditedImageInConversation=async(session,imageUrl)=>{
  const conversationId=await ensureConversationForAttachment(session);
  const response=await fetch(imageUrl,{cache:"no-store"});
  if(!response.ok)throw new Error("ذخیره خروجی ویرایش در تاریخچه گفتگو ناموفق بود.");
  const blob=await response.blob();
  const mimeType=["image/jpeg","image/png","image/webp"].includes(blob.type)?blob.type:"image/jpeg";
  const filename="lokal-ai-edited-image."+({ "image/png":"png","image/webp":"webp" }[mimeType]||"jpg");
  const init=await callArmexApi(session,"",{action:"create_media_upload",conversation_id:conversationId,
   mime_type:mimeType,filename,size_bytes:blob.size});
  if(init.success!==true||!init.attachment_id||!init.path||!init.token||!init.bucket)throw new Error("آماده‌سازی ذخیره خروجی ویرایش ناموفق بود.");
  const {error:uploadError}=await supabase.storage.from(init.bucket).uploadToSignedUrl(
   init.path,init.token,blob,{contentType:mimeType,cacheControl:"3600"}
  );
  if(uploadError)throw new Error("ذخیره خروجی ویرایش انجام نشد: "+uploadError.message);
  const completed=await callArmexApi(session,"",{action:"complete_media_upload",attachment_id:init.attachment_id});
  if(completed.success!==true||!completed.attachment?.signed_url)throw new Error("تأیید ذخیره خروجی ویرایش ناموفق بود.");
  return completed.attachment;
 };
 const runChatImageEdit=async(session,prompt,attachments)=>{
  const imageList=Array.isArray(attachments)?attachments:attachments?[attachments]:[];
  if(imageList.length<1||imageList.length>3)throw new Error("برای ویرایش هم‌زمان باید ۱ تا ۳ تصویر انتخاب شود.");
  setChatStatus("در حال آماده‌سازی امن "+imageList.length+" تصویر مرجع برای موتور ویرایش…");
  const conversationId=await ensureConversationForAttachment(session);
  const queued=await callArmexApi(session,"",{action:"edit_image",request_id:crypto.randomUUID(),
   conversation_id:conversationId,attachment_ids:imageList.map(item=>item.id),prompt});
  if(queued?.success!==true||!queued?.job?.id){
   if(queued?.code==="daily_quota_exceeded"||queued?.status===429)throw new Error("سهمیه رایگان ویرایش تصویر امروز تمام شده است.");
   throw new Error(queued?.error||"ثبت درخواست ویرایش تصویر ناموفق بود.");
  }
  const started=Date.now();
  while(Date.now()-started<240000){
   await new Promise(resolve=>setTimeout(resolve,3000));
   const status=await callArmexApi(session,"?action=image_edit_status&job_id="+encodeURIComponent(queued.job.id));
   const job=status?.job;
   if(status?.success!==true||!job)throw new Error("وضعیت پردازش تصویر دریافت نشد.");
   if(job.status==="completed"&&job.image_url)return job.image_url;
   if(job.status==="failed"){
    const code=String(job.error_code||"");
    if(/429|quota|capacity/i.test(code))throw new Error("ظرفیت رایگان موتور ویرایش تصویر فعلاً در دسترس نیست؛ بعداً دوباره تلاش کن.");
    throw new Error("موتور ویرایش نتوانست تصویر را پردازش کند. لطفاً دوباره تلاش کن.");
   }
   setChatStatus(job.status==="processing"?"موتور هوش مصنوعی در حال ویرایش تصویر است…":"درخواست ویرایش تصویر در صف پردازش است…");
  }
  throw new Error("پردازش تصویر طول کشید؛ نتیجه را از تاریخچه ویرایش تصویر پیگیری کن.");
 };
 const sendChatMessage=async()=>{
  const typedMessage=chatInput?.value?.trim()||"";
  if((!typedMessage&&!selectedImageFiles.length&&!uploadedAttachments.length)||chatRequestBusy)return;
  const hasSelectedImages=selectedImageFiles.length>0||uploadedAttachments.length>0;
  const message=typedMessage||(hasSelectedImages?"لطفاً این تصاویر را بررسی و توصیف کن.":"");
  const {data:{session}}=await supabase.auth.getSession();
  if(!session){setChatStatus("برای استفاده از چت ابتدا وارد حساب کاربری شو.",true);return}
  chatRequestBusy=true;chatSend.disabled=true;chatInput.disabled=true;if(attachButton)attachButton.disabled=true;
  try{
   await ensureSecureApi(session);
   const attachments=await uploadSelectedImages(session);
   const imageForEdit=attachments.length?attachments:(Array.isArray(lastImageContext)?lastImageContext:lastImageContext?[lastImageContext]:[]);
   const wantsImageEdit=isImageEditRequest(typedMessage);
   if(wantsImageEdit&&!imageForEdit.length){
    addChatMessage("assistant","حتماً؛ عکس یا عکس‌ها رو هم بفرست تا ویرایششون کنم.");
    setChatStatus("برای ویرایش تصویر، حداقل یک عکس لازمه. این پیام به چت متنی ارسال نشد و اعتباری مصرف نکرد.");
    return;
   }
   if(wantsImageEdit){
    const conversationId=await ensureConversationForAttachment(session);
    const editMessageRequestId=crypto.randomUUID();
    const savedPrompt=await callArmexApi(session,"",{action:"save_chat_message",conversation_id:conversationId,
     request_id:editMessageRequestId,role:"user",content:typedMessage,model:"openai/gpt-4o-mini",
     attachment_ids:imageForEdit.map(item=>item.id)});
    if(savedPrompt?.success!==true)throw new Error(savedPrompt?.error||"ثبت درخواست ویرایش در تاریخچه گفتگو ناموفق بود.");
    addChatMessage("user",message,imageForEdit);
    const outputUrl=await runChatImageEdit(session,typedMessage,imageForEdit);
    setChatStatus("در حال ذخیره نتیجه در تاریخچه گفتگو…");
    const savedOutput=await persistEditedImageInConversation(session,outputUrl);
    const completionNote="انجام شد؛ این نسخه هم به تاریخچه گفتگوت اضافه شد.";
    const savedNote=await callArmexApi(session,"",{action:"save_chat_message",conversation_id:conversationId,
     request_id:crypto.randomUUID(),role:"assistant",content:completionNote,model:"openai/gpt-4o-mini",attachment_id:savedOutput.id});
    addChatMessage("assistant",completionNote,savedOutput);
    lastImageContext=[savedOutput];
    window.LOKAL_PROMPT_REFERENCE_IMAGE_URL=savedOutput?.signed_url||"";
    window.LOKAL_PROMPT_REFERENCE_IMAGE_URLS=lastImageContext.map(item=>item.signed_url).filter(Boolean);
    chatInput.value="";clearSelectedImage();
    setChatStatus(savedNote?.success===true?"ویرایش تصویر کامل شد · درخواست و نتیجه در تاریخچه ذخیره شدند.":"تصویر ذخیره شد؛ ثبت متن نتیجه در تاریخچه کامل نشد.");
    await loadChatHistoryList(session);
    return;
   }
   setChatStatus("در حال دریافت پاسخ هوش مصنوعی…");
   const safeMessage=String(message||"").trim();
   if(!safeMessage||safeMessage.length>12000)throw new Error("متن پیام برای ارسال معتبر نیست؛ لطفاً دوباره تلاش کن.");
   const payload={request_id:crypto.randomUUID(),message:safeMessage,model:"openai/gpt-4o-mini",max_tokens:1200};
   if(activeChatConversationId)payload.conversation_id=activeChatConversationId;
   if(attachments.length)payload.attachment_ids=attachments.map(item=>item.id);
   const result=await callArmexApi(session,"",payload);
   if(result.success!==true||!result.answer||!result.conversation_id){
    if(result.pending)throw new Error("درخواستت در حال بررسی است؛ برای جلوگیری از اجرای تکراری، پیام را دوباره ارسال نکن.");
    throw new Error(result.error||"پاسخ معتبر از سرویس چت دریافت نشد.");
   }
   activeChatConversationId=result.conversation_id;
   addChatMessage("user",message,attachments);
   addChatMessage("assistant",result.answer);
   chatInput.value="";clearSelectedImage();chatTitle.textContent="گفتگو";
   const creditsCharged=Number(result.usage?.credits_charged??0);
   setChatStatus(creditsCharged===0?"پاسخ آماده شد · چت رایگان بود.":"پاسخ آماده شد · "+creditsCharged.toLocaleString("fa-IR")+" اعتبار مصرف شد.");
   await Promise.all([loadWalletBalance(session),loadChatHistoryList(session)]);
  }catch(error){
   setChatStatus(String(error?.message||"ارسال پیام ناموفق بود."),true);
   await loadWalletBalance(session);
  }finally{
   chatRequestBusy=false;chatSend.disabled=false;chatInput.disabled=false;if(attachButton)attachButton.disabled=false;chatInput.focus();
  }
 };
 document.getElementById("chat-exit")?.addEventListener("click",()=>document.querySelector('[data-page="home"]')?.click());
 document.getElementById("chat-new")?.addEventListener("click",()=>{
  closeHistoryDrawer();
  if(selectedImageFiles.length||uploadedAttachments.length){setChatStatus("تصاویر پیوست‌شده هنوز ارسال نشده‌اند؛ ابتدا همان پیام را ارسال کن.",true);return}
  activeChatConversationId=null;lastImageContext=[];window.LOKAL_PROMPT_REFERENCE_IMAGE_URL="";window.LOKAL_PROMPT_REFERENCE_IMAGE_URLS=[];chatTitle.textContent="گفتگوی جدید";clearSelectedImage();renderChatHistory([]);
  setChatStatus("");chatHistoryList?.querySelectorAll(".chat-history-item").forEach(item=>item.classList.remove("active"));chatInput?.focus();
 });
 chatHistoryList?.addEventListener("click",async event=>{
  const button=event.target.closest("[data-conversation-id]");if(!button)return;
  if(selectedImageFiles.length||uploadedAttachments.length){setChatStatus("ابتدا تصاویر پیوست‌شده را ارسال کن؛ سپس می‌توانی گفتگوی دیگری باز کنی.",true);return}
  const {data:{session}}=await supabase.auth.getSession();
  if(session){await openChatHistory(button.dataset.conversationId,session);closeHistoryDrawer()}
 });
 attachButton?.addEventListener("click",()=>{
  if(selectedImageFiles.length>=3){setChatStatus("حداکثر سه تصویر را می‌توانی هم‌زمان ارسال کنی.");return}
  attachmentInput?.click();
 });
 attachmentInput?.addEventListener("change",()=>{
  const files=Array.from(attachmentInput.files||[]);
  if(!files.length)return;
  if(selectedImageFiles.length+files.length>3){setChatStatus("حداکثر سه تصویر را می‌توانی هم‌زمان ارسال کنی.",true);attachmentInput.value="";return}
  const invalid=files.find(file=>!["image/jpeg","image/png","image/webp"].includes(file.type));
  if(invalid){setChatStatus("فقط تصاویر JPG، PNG و WebP پشتیبانی می‌شوند.",true);attachmentInput.value="";return}
  const oversized=files.find(file=>file.size<=0||file.size>20*1024*1024);
  if(oversized){setChatStatus("حجم هر تصویر باید حداکثر ۲۰ مگابایت باشد.",true);attachmentInput.value="";return}
  files.forEach(file=>{
   selectedImageFiles.push(file);
   const url=URL.createObjectURL(file);selectedImageUrls.push(url);activeObjectUrls.push(url);
   uploadedAttachments.push(null);
  });
  renderSelectedImage();setChatStatus(files.length+" تصویر اضافه شد؛ متن دلخواهت را بنویس و ارسال کن.");
  attachmentInput.value="";
 });
 chatSend?.addEventListener("click",sendChatMessage);
 chatInput?.addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();sendChatMessage()}});
 document.querySelectorAll('[data-page="chat"]').forEach(button=>button.addEventListener("click",async()=>{
  const {data:{session}}=await supabase.auth.getSession();if(session)await loadChatHistoryList(session);
 }));
 supabase.auth.onAuthStateChange((event,session)=>{
  if(event==="SIGNED_IN"&&session)void loadChatHistoryList(session);
  if(event==="SIGNED_OUT"){activeChatConversationId=null;lastImageContext=[];window.LOKAL_PROMPT_REFERENCE_IMAGE_URL="";window.LOKAL_PROMPT_REFERENCE_IMAGE_URLS=[];window.LOKAL_PROMPT_REFERENCE_IMAGE=null;clearSelectedImage();chatHistoryList?.replaceChildren();renderChatHistory([]);setChatStatus("")}
 });
 void supabase.auth.getSession().then(({data:{session}})=>{if(session)void loadChatHistoryList(session)});
}
