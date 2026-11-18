import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const chat = await readFile(new URL("../modules/chat/chat.js", import.meta.url), "utf8");
const theme = await readFile(new URL("../styles/lokal-luxe-theme.css", import.meta.url), "utf8");

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
  assert.match(chat, /persistEditedImageInConversation/);
  assert.match(chat, /if\(wantsImageEdit&&\(!imageForEdit/);
  assert.match(chat, /این پیام به چت متنی ارسال نشد و اعتباری مصرف نکرد/);
});

test("LOKAL AI theme uses champagne gold, not pure black, and retains blue/violet glow", () => {
  assert.match(theme, /color-scheme\s*:\s*light/);
  assert.match(theme, /--bg\s*:\s*#f4ead5/i);
  assert.match(theme, /--gold\s*:\s*#d4a13d/i);
  assert.match(theme, /#9a65df38/i);
  assert.match(theme, /#42bde735/i);
  assert.doesNotMatch(theme, /#000000|#070709|#05080b/i);
});
