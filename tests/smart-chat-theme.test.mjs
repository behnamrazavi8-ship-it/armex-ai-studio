import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const chat = await readFile(new URL("../modules/chat/chat.js", import.meta.url), "utf8");
const theme = await readFile(new URL("../styles/lokal-luxe-theme.css", import.meta.url), "utf8");
const edge = await readFile(new URL("../supabase/functions/armex-api/index.ts", import.meta.url), "utf8");
const chatMigration = await readFile(new URL("../supabase/migrations/20261118180000_lokal_free_chat_idempotency.sql", import.meta.url), "utf8");
const imageEditApi = await readFile(new URL("../supabase/functions/armex-api/image-edit-api.ts", import.meta.url), "utf8");

test("Smart Chat recognizes Persian follow-up image edit requests", () => {
  const match = chat.match(/return \/(.+)\/i\.test\(text\);/);
  assert.ok(match, "image edit intent classifier must exist");
  const intent = new RegExp(match[1], "i");
  for (const phrase of [
    "ویرایش تصویری که انجام دادی",
    "همون عکس رو اصلاح کن",
    "پس زمینه رو سفید کن",
    "خروجی قبلی رو درستش کن",
  ]) assert.match(phrase, intent, phrase);
});

test("Smart Chat reuses and restores the latest image context", () => {
  assert.match(chat, /lastImageContext=historicalImages\.length\?historicalImages\[historicalImages\.length-1\]:null/);
  assert.match(chat, /const imageForEdit\s*=\s*attachment\s*\|\|\s*lastImageContext/);
  assert.match(chat, /lastImageContext\s*=\s*savedOutput/);
  assert.match(chat, /lastImageContext\s*=\s*editedImage/);
  assert.match(chat, /ویرایش تصویر با موفقیت انجام شد/);
  assert.doesNotMatch(chat, /action:"save_chat_message"/);
  assert.doesNotMatch(chat, /persistEditedImageInConversation/);
  assert.match(chat, /if\(wantsImageEdit&&\(!imageForEdit/);
  assert.match(chat, /این پیام به چت متنی ارسال نشد و اعتباری مصرف نکرد/);
  assert.match(chat, /result\.usage\?\.credits_charged\?\?0/);
  assert.match(chat, /پاسخ آماده شد · چت رایگان بود/);
});

test("LOKAL AI theme uses champagne gold, not pure black, and retains blue/violet glow", () => {
  assert.match(theme, /color-scheme\s*:\s*light/);
  assert.match(theme, /--bg\s*:\s*#f4ead5/i);
  assert.match(theme, /--gold\s*:\s*#d4a13d/i);
  assert.match(theme, /#9a65df38/i);
  assert.match(theme, /#42bde735/i);
  assert.doesNotMatch(theme, /#000000|#070709|#05080b/i);
});

test("Smart Chat is free without disabling provider-cost accounting", () => {
  assert.match(edge, /const chatCreditCost = 0;/);
  assert.match(edge, /if \(chatCreditCost > 0\)/);
  assert.match(edge, /p_debit_outcome: chatCreditCost > 0 \? "debited" : "not_charged"/);
  assert.match(chatMigration, /credits_charged, request_id/);
  assert.match(chatMigration, /p_actual_cost_usd, 0, p_request_id/);
  assert.match(chatMigration, /constraint armex_chat_requests_free_chat_only check \(credits = 0 and debit_outcome = 'not_charged'\)/);
  assert.match(chatMigration, /on conflict \(request_id\) do nothing/i);
  assert.match(chatMigration, /provider_response_payload = coalesce\(p_provider_response_payload, provider_response_payload\)/);
});

test("Current image edit and chat media APIs remain wired into the feature backend", () => {
  assert.match(edge, /import \{ handleImageEditApi \} from "\.\/image-edit-api\.ts"/);
  assert.match(edge, /const CHAT_MEDIA_BUCKET = "lokal-chat-media"/);
  assert.ok(edge.includes('url.searchParams.get("action") === "conversation"'));
  assert.match(edge, /body\.action === "create_media_upload"/);
  assert.match(edge, /body\.action === "complete_media_upload"/);
  assert.match(edge, /body\.action === "edit_image"/);
  assert.match(edge, /body\.action === "save_chat_message"/);
  assert.match(edge, /listChatAttachments\(db, userId, conversationId\)/);
  assert.match(imageEditApi, /armex_enqueue_image_edit/);
});

test("Image-edit prompt and completion are saved to the same conversation", () => {
  assert.match(chat, /addChatMessage\("user",message,imageForEdit\)/);
  assert.match(chat, /addChatMessage\("assistant","ویرایش تصویر با موفقیت انجام شد:",editedImage\)/);
  assert.match(chat, /lastImageContext=editedImage/);
});
