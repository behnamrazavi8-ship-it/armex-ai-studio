import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const api = await readFile("supabase/functions/armex-api/index.ts", "utf8");
const migration = await readFile("supabase/migrations/20261115000000_lokal_chat_media.sql", "utf8");
const chat = await readFile("modules/chat/chat.js", "utf8");
const html = await readFile("index.html", "utf8");

test("chat media API uses authenticated signed uploads and server verification", () => {
  assert.match(api, /createChatMediaUpload/);
  assert.match(api, /createSignedUploadUrl/);
  assert.match(api, /completeChatMediaUpload/);
  assert.match(api, /hasValidMediaSignature/);
  assert.match(api, /\.eq\("id", attachmentId\)\.eq\("user_id", userId\)/);
  assert.match(api, /\.eq\("conversation_id", conversationId\)/);
  assert.match(api, /crypto\.subtle\.digest\("SHA-256"/);
});

test("chat attachments are owner-scoped, private and bounded", () => {
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.armex_chat_attachments from anon, authenticated/i);
  assert.match(migration, /'lokal-chat-media', 'lokal-chat-media', false, 52428800/);
  assert.match(api, /CHAT_MEDIA_MAX_IMAGE_BYTES = 20 \* 1024 \* 1024/);
  assert.match(api, /CHAT_MEDIA_MAX_VIDEO_BYTES = 50 \* 1024 \* 1024/);
  assert.match(api, /createSignedUrl\(String\(item\.storage_path\), 300\)/);
});

test("chat sends verified images to vision models without claiming video understanding", () => {
  assert.match(api, /attachmentId != null && !isUuid\(attachmentId\)/);
  assert.match(api, /createSignedUrl\(String\(attachment\.storage_path\), 300\)/);
  assert.match(api, /image_url: \{ url: imageSignedUrl \}/);
  assert.match(api, /video understanding\/editing is not available in this release/);
  assert.match(chat, /uploadToSignedUrl/);
  assert.match(chat, /attachment_id = pendingAttachment\.id/);
  assert.match(html, /id="chat-media-input"/);
  assert.match(html, /id="chat-attachment-preview"/);
});
