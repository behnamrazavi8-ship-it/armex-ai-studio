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
 let activeChatConversationId=null;
 let chatRequestBusy=false;
 let selectedImageFile=null;
 let selectedImageUrl="";
 let uploadedAttachment=null;
 let lastImageContext=null;

 const style=document.createElement("style");
 style.id="lokal-chat-attachment-styles";
 style.textContent=`
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
 `;
 if(!document.getElementById(style.id))document.head.append(style);

 let activeObjectUrl="";
 const setChatStatus=(message,isError=false)=>{if(!chatStatus)return;chatStatus.textContent=message||"";chatStatus.style.color=isError?"#ffb8c2":"#91aaa9"};
 const addChatMessage=(role,content,attachment=null)=>{
  const bubble=document.createElement("div");
  bubble.className="chat-message "+(role==="user"?"user":"assistant");
  const text=document.createElement("div");text.textContent=String(content||"");bubble.append(text);
  if(attachment?.signed_url&&String(attachment.mime_type||"").startsWith("image/")){
   const image=document.createElement("img");image.className="chat-message-attachment";
   image.src=attachment.signed_url;image.alt=attachment.original_filename||"تصویر پیوست‌شده";
   image.loading="lazy";bubble.append(image);
  }
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
  }else messages.forEach(item=>addChatMessage(item.role,item.content));
  renderAttachmentHistory(attachments);
 };
 const renderSelectedImage=()=>{
  if(!attachmentPreview)return;
  attachmentPreview.replaceChildren();
  if(!selectedImageFile){attachmentPreview.hidden=true;return}
  const image=document.createElement("img");image.src=selectedImageUrl;image.alt="پیش‌نمایش عکس انتخاب‌شده";
  const label=document.createElement("span");label.textContent=selectedImageFile.name+" · "+(selectedImageFile.size/1024/1024).toFixed(1)+" MB";
  attachmentPreview.append(image,label);attachmentPreview.hidden=false;
 };
 const clearSelectedImage=()=>{
  if(activeObjectUrl){URL.revokeObjectURL(activeObjectUrl);activeObjectUrl=""}
  selectedImageFile=null;selectedImageUrl="";uploadedAttachment=null;
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
   lastImageContext=historicalImages.length?historicalImages[historicalImages.length-1]:null;
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
 const uploadSelectedImage=async(session)=>{
  if(uploadedAttachment)return uploadedAttachment;
  if(!selectedImageFile)return null;
  const conversationId=await ensureConversationForAttachment(session);
  setChatStatus("در حال آماده‌سازی بارگذاری امن تصویر…");
  const init=await callArmexApi(session,"",{action:"create_media_upload",conversation_id:conversationId,
   mime_type:selectedImageFile.type,filename:selectedImageFile.name,size_bytes:selectedImageFile.size});
  if(init.success!==true||!init.attachment_id||!init.path||!init.token||!init.bucket)throw new Error("آماده‌سازی بارگذاری تصویر ناموفق بود.");
  const {error:uploadError}=await supabase.storage.from(init.bucket).uploadToSignedUrl(
   init.path,init.token,selectedImageFile,{contentType:selectedImageFile.type,cacheControl:"3600"}
  );
  if(uploadError)throw new Error("آپلود تصویر انجام نشد: "+uploadError.message);
  setChatStatus("تصویر بارگذاری شد؛ در حال بررسی امن فایل…");
  const completed=await callArmexApi(session,"",{action:"complete_media_upload",attachment_id:init.attachment_id});
  if(completed.success!==true||!completed.attachment?.id)throw new Error("تأیید امن تصویر انجام نشد.");
  uploadedAttachment=completed.attachment;
  return uploadedAttachment;
 };

 const isImageEditRequest=(message)=>{
  const text=String(message||"").toLowerCase().replace(/[ي]/g,"ی").replace(/[ك]/g,"ک");
  return /(ویرایش|ادیت|تغییر|عوض کن|تبدیل کن|سفید کن|سیاه کن|روشن کن|تیره کن|حذف کن|پاک کن|جایگزین کن|اضافه کن|برش بده|کراپ|روتوش|اصلاح کن|اصلاحش|درستش کن|پس\s*زمینه|بک\s*گراند|تصویر قبلی|عکس قبلی|خروجی قبلی|همون عکس|همون تصویر|background|retouch|\bedit\b|\bremove\b|\breplace\b)/i.test(text);
 };
 const imageBlobToPayload=async(blob)=>{
  const bitmap=await createImageBitmap(blob);
  if(bitmap.width*bitmap.height>40000000){bitmap.close();throw new Error("ابعاد تصویر بیش از حد بزرگ است؛ لطفاً نسخه کوچک‌تری انتخاب کن.")}
  let prepared=null;
  for(const maxSide of [1024,768,640]){
   const scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
   const canvas=document.createElement("canvas");
   canvas.width=Math.max(1,Math.round(bitmap.width*scale));
   canvas.height=Math.max(1,Math.round(bitmap.height*scale));
   const context=canvas.getContext("2d",{alpha:true});
   if(!context)continue;
   context.clearRect(0,0,canvas.width,canvas.height);
   context.drawImage(bitmap,0,0,canvas.width,canvas.height);
   const output=await new Promise(resolve=>canvas.toBlob(resolve,"image/webp",0.86));
   if(output&&output.size<=5*1024*1024){prepared=output;break}
  }
  bitmap.close();
  if(!prepared)throw new Error("آماده‌سازی تصویر برای ویرایش انجام نشد؛ یک تصویر کم‌حجم‌تر انتخاب کن.");
  const bytes=new Uint8Array(await prepared.arrayBuffer());let binary="";
  for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return {image_base64:btoa(binary),mime_type:"image/webp"};
 };
 const prepareChatImageForEdit=async(attachment)=>{
  if(!attachment?.signed_url||!String(attachment.mime_type||"").startsWith("image/"))throw new Error("برای ویرایش، ابتدا یک تصویر معتبر پیوست کن.");
  const response=await fetch(attachment.signed_url,{cache:"no-store"});
  if(!response.ok)throw new Error("دریافت تصویر پیوست برای ویرایش ناموفق بود.");
  return imageBlobToPayload(await response.blob());
 };

 const runChatImageEdit=async(session,prompt,attachment)=>{
  setChatStatus("در حال آماده‌سازی تصویر برای موتور ویرایش…");
  const prepared=await prepareChatImageForEdit(attachment);
  const queued=await callArmexApi(session,"",{action:"edit_image",request_id:crypto.randomUUID(),prompt,...prepared});
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
  if((!typedMessage&&!selectedImageFile&&!uploadedAttachment)||chatRequestBusy)return;
  const message=typedMessage||(selectedImageFile||uploadedAttachment?"لطفاً این تصویر را بررسی و توصیف کن.":"");
  const {data:{session}}=await supabase.auth.getSession();
  if(!session){setChatStatus("برای استفاده از چت ابتدا وارد حساب کاربری شو.",true);return}
  chatRequestBusy=true;chatSend.disabled=true;chatInput.disabled=true;if(attachButton)attachButton.disabled=true;
  try{
   await ensureSecureApi(session);
   const attachment=await uploadSelectedImage(session);
   const imageForEdit=attachment||lastImageContext;
   const wantsImageEdit=isImageEditRequest(typedMessage);
   if(wantsImageEdit&&(!imageForEdit||!String(imageForEdit.mime_type||"").startsWith("image/"))){
    addChatMessage("assistant","حتماً؛ فقط عکس رو هم بفرست تا ویرایشش کنم.");
    setChatStatus("برای ویرایش تصویر، عکس لازمه. این پیام به چت متنی ارسال نشد و اعتباری مصرف نکرد.");
    return;
   }
   if(wantsImageEdit){
    addChatMessage("user",message,imageForEdit);
    const outputUrl=await runChatImageEdit(session,typedMessage,imageForEdit);
    const editedImage={signed_url:outputUrl,mime_type:"image/jpeg",original_filename:"lokal-ai-edited-image.jpg"};
    addChatMessage("assistant","ویرایش تصویر با موفقیت انجام شد. خروجی آماده است:",editedImage);
    lastImageContext=editedImage;
    chatInput.value="";clearSelectedImage();
    setChatStatus("ویرایش تصویر کامل شد · بدون مصرف اعتبار چت.");
    return;
   }
   setChatStatus("در حال دریافت پاسخ هوش مصنوعی…");
   const payload={request_id:crypto.randomUUID(),message,model:"openai/gpt-4o-mini",max_tokens:1200};
   if(activeChatConversationId)payload.conversation_id=activeChatConversationId;
   if(attachment?.id)payload.attachment_id=attachment.id;
   const result=await callArmexApi(session,"",payload);
   if(result.success!==true||!result.answer||!result.conversation_id){
    if(result.pending)throw new Error("درخواستت در حال بررسی است؛ برای جلوگیری از اجرای تکراری، پیام را دوباره ارسال نکن.");
    throw new Error(result.error||"پاسخ معتبر از سرویس چت دریافت نشد.");
   }
   activeChatConversationId=result.conversation_id;
   addChatMessage("user",message,attachment);
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
 document.getElementById("chat-new")?.addEventListener("click",()=>{
  if(uploadedAttachment){setChatStatus("تصویر بارگذاری‌شده هنوز ارسال نشده است؛ ابتدا همان پیام را ارسال کن.",true);return}
  activeChatConversationId=null;lastImageContext=null;chatTitle.textContent="گفتگوی جدید";clearSelectedImage();renderChatHistory([]);
  setChatStatus("");chatHistoryList?.querySelectorAll(".chat-history-item").forEach(item=>item.classList.remove("active"));chatInput?.focus();
 });
 chatHistoryList?.addEventListener("click",async event=>{
  const button=event.target.closest("[data-conversation-id]");if(!button)return;
  if(uploadedAttachment){setChatStatus("ابتدا تصویر پیوست‌شده را ارسال کن؛ سپس می‌توانی گفتگوی دیگری باز کنی.",true);return}
  const {data:{session}}=await supabase.auth.getSession();if(session)await openChatHistory(button.dataset.conversationId,session);
 });
 attachButton?.addEventListener("click",()=>{
  if(uploadedAttachment){setChatStatus("ابتدا تصویر پیوست‌شده را ارسال کن.",true);return}
  attachmentInput?.click();
 });
 attachmentInput?.addEventListener("change",()=>{
  const file=attachmentInput.files?.[0];if(!file)return;
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)){setChatStatus("فقط تصاویر JPG، PNG و WebP پشتیبانی می‌شوند.",true);attachmentInput.value="";return}
  if(file.size<=0||file.size>20*1024*1024){setChatStatus("حجم تصویر باید حداکثر ۲۰ مگابایت باشد.",true);attachmentInput.value="";return}
  if(activeObjectUrl)URL.revokeObjectURL(activeObjectUrl);
  selectedImageFile=file;uploadedAttachment=null;activeObjectUrl=URL.createObjectURL(file);selectedImageUrl=activeObjectUrl;
  renderSelectedImage();setChatStatus("تصویر آماده ارسال است؛ متن دلخواهت را بنویس و ارسال کن.");
 });
 chatSend?.addEventListener("click",sendChatMessage);
 chatInput?.addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();sendChatMessage()}});
 document.querySelectorAll('[data-page="chat"]').forEach(button=>button.addEventListener("click",async()=>{
  const {data:{session}}=await supabase.auth.getSession();if(session)await loadChatHistoryList(session);
 }));
 supabase.auth.onAuthStateChange((event,session)=>{
  if(event==="SIGNED_IN"&&session)void loadChatHistoryList(session);
  if(event==="SIGNED_OUT"){activeChatConversationId=null;lastImageContext=null;clearSelectedImage();chatHistoryList?.replaceChildren();renderChatHistory([]);setChatStatus("")}
 });
 void supabase.auth.getSession().then(({data:{session}})=>{if(session)void loadChatHistoryList(session)});
}
