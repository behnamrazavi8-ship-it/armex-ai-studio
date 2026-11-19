import test from "node:test";
import assert from "node:assert/strict";
import { isImageEditRequest } from "../modules/chat/image-edit-intent.mjs";

for (const phrase of [
  "یه خورده از میز فاصله بده",
  "بخاری رو کمی بزرگ‌تر کن",
  "پس‌زمینه رو سفید کن",
  "این دو عکس رو با هم ترکیب کن",
  "سوژه رو به سمت راست جابه‌جا کن",
  "نور تصویر رو روشن‌تر کن"
]) test("routes image edit: " + phrase, () => assert.equal(isImageEditRequest(phrase), true));

for (const phrase of [
  "این عکس چه چیزی رو نشون میده؟",
  "رنگ این بخاری چیه؟",
  "کیفیت این تصویر خوبه؟"
]) test("keeps image questions in vision chat: " + phrase, () => assert.equal(isImageEditRequest(phrase), false));
