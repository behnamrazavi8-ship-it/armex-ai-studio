import test from "node:test";
import assert from "node:assert/strict";

const isImageEditRequest = (message) => {
  const text = String(message || "").toLowerCase().replace(/[ي]/g, "ی").replace(/[ك]/g, "ک").replace(/[\u200c\u200f]/g, " ");
  return /(ویرایش|ادیت|تغییر|عوض کن|تبدیل کن|سفید کن|سیاه کن|روشن کن|تیره کن|روشن‌تر|تیره‌تر|حذف کن|حذفش|پاک کن|جایگزین کن|اضافه کن|برش بده|کراپ|روتوش|اصلاح کن|اصلاحش|درستش کن|فاصله\s*بده|دورتر|نزدیک‌تر|نزدیکتر|جابه‌جا|جابجا|جا\s*به\s*جا|منتقل کن|انتقال بده|ببر|بذار|بگذار|قرار بده|بچسبون|بچسبان|بزرگ‌تر|بزرگتر|کوچک‌تر|کوچکتر|کوچیک‌تر|کوچیکتر|بزرگ کن|کوچک کن|کوچیک کن|بالاتر|پایین‌تر|پایینتر|سمت چپ|سمت راست|کنار هم|پس\s*زمینه|بک\s*گراند|تصویر قبلی|عکس قبلی|خروجی قبلی|همون عکس|همون تصویر|ترکیب(?:\s*کن|\s*کردن)|ادغام(?:\s*کن|\s*کردن)|مونتاژ|تصویر اول|عکس اول|تصویر دوم|عکس دوم|از این تصاویر|این دو عکس|این سه عکس|background|retouch|\bedit\b|\bremove\b|\breplace\b|\bcombine\b|\bmerge\b|\bcomposite\b|\bmove\b|\bresize\b|\bbrighten\b|\bdarken\b)/i.test(text);
};

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
