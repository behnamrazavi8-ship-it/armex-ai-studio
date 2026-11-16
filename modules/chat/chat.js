// Smart Chat UI module for the latest LOKAL AI workspace.
// Backend access, auth and wallet refresh are injected by the host app.
export function initSmartChat({ supabase, callArmexApi, loadWalletBalance, ensureSecureApi }) {
 const chatHistoryList=document.getElementById("chat-history-list");
 const chatTranscript=document.getElementById("chat-transcript");
 const chatInput=document.getElementById("chat-input");
 const chatSend=document.getElementById("chat-send");
 const chatStatus=document.getElementById("chat-status");
 const chatTitle=document.getElementById("chat-title");
 let activeChatConversationId=null;
 let chatRequestBusy=false;
 const setChatStatus=(message,isError=false)=>{if(!chatStatus)return;chatStatus.textContent=message||"";chatStatus.style.color=isError?"#ffb8c2":"#91aaa9"};
 const addChatMessage=(role,content)=>{
  const bubble=document.createElement("div");
  bubble.className="chat-message "+(role==="user"?"user":"assistant");
  bubble.textContent=String(content||"");
  chatTranscript.append(bubble);
  chatTranscript.scrollTop=chatTranscript.scrollHeight;
 };
 const renderChatHistory=(messages)=>{
  chatTranscript.replaceChildren();
  if(!messages?.length){
   const empty=document.createElement("div");empty.className="chat-empty-state";
   const heading=document.createElement("b");heading.textContent="سلام! من دستیار هوشمند LOKAL AI هستم.";
   empty.append(heading,document.createTextNode("سؤال یا ایده‌ات را بنویس تا شروع کنیم."));
   chatTranscript.append(empty);return;
  }
  messages.forEach(item=>addChatMessage(item.role,item.content));
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
   const result=await callArmexApi(session,"?action=conversation_messages&id="+encodeURIComponent(id));
   if(result.success!==true||!Array.isArray(result.messages))throw new Error("پاسخ تاریخچه معتبر نیست.");
   activeChatConversationId=id;chatTitle.textContent="گفتگو";
   renderChatHistory(result.messages);await loadChatHistoryList(session);setChatStatus("");
  }catch(error){setChatStatus("بارگذاری گفتگو انجام نشد: "+String(error?.message||error),true)}
 };
 const sendChatMessage=async()=>{
  const message=chatInput?.value?.trim()||"";
  if(!message||chatRequestBusy)return;
  const {data:{session}}=await supabase.auth.getSession();
  if(!session){setChatStatus("برای استفاده از چت ابتدا وارد حساب کاربری شو.",true);return}
  chatRequestBusy=true;chatSend.disabled=true;chatInput.disabled=true;
  try{
   await ensureSecureApi(session);
   addChatMessage("user",message);chatInput.value="";
   setChatStatus("در حال دریافت پاسخ هوش مصنوعی…");
   const payload={request_id:crypto.randomUUID(),message,model:"openai/gpt-4o-mini",max_tokens:1200};
   if(activeChatConversationId)payload.conversation_id=activeChatConversationId;
   const result=await callArmexApi(session,"",payload);
   if(result.success!==true||!result.answer||!result.conversation_id){
    if(result.pending)throw new Error("درخواست برای بررسی وضعیت مالی در صف تطبیق قرار گرفت؛ پیام را دوباره ارسال نکن.");
    throw new Error("پاسخ معتبر از سرویس چت دریافت نشد.");
   }
   activeChatConversationId=result.conversation_id;
   addChatMessage("assistant",result.answer);
   chatTitle.textContent="گفتگو";
   setChatStatus("پاسخ آماده شد · "+Number(result.usage?.credits_charged||1).toLocaleString("fa-IR")+" اعتبار مصرف شد.");
   await Promise.all([loadWalletBalance(session),loadChatHistoryList(session)]);
  }catch(error){
   setChatStatus(String(error?.message||"ارسال پیام ناموفق بود."),true);
   await loadWalletBalance(session);
  }finally{chatRequestBusy=false;chatSend.disabled=false;chatInput.disabled=false;chatInput.focus()}
 };
 document.getElementById("chat-new")?.addEventListener("click",()=>{
  activeChatConversationId=null;chatTitle.textContent="گفتگوی جدید";renderChatHistory([]);
  setChatStatus("");chatHistoryList?.querySelectorAll(".chat-history-item").forEach(item=>item.classList.remove("active"));chatInput?.focus();
 });
 chatHistoryList?.addEventListener("click",async event=>{
  const button=event.target.closest("[data-conversation-id]");if(!button)return;
  const {data:{session}}=await supabase.auth.getSession();if(session)await openChatHistory(button.dataset.conversationId,session);
 });
 chatSend?.addEventListener("click",sendChatMessage);
 chatInput?.addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();sendChatMessage()}});
 document.querySelectorAll('[data-page="chat"]').forEach(button=>button.addEventListener("click",async()=>{
  const {data:{session}}=await supabase.auth.getSession();if(session)await loadChatHistoryList(session);
 }));
 supabase.auth.onAuthStateChange((event,session)=>{
  if(event==="SIGNED_IN"&&session)void loadChatHistoryList(session);
  if(event==="SIGNED_OUT"){activeChatConversationId=null;chatHistoryList?.replaceChildren();renderChatHistory([]);setChatStatus("")}
 });
 void supabase.auth.getSession().then(({data:{session}})=>{if(session)void loadChatHistoryList(session)});


}
