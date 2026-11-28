import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
test("Prompt Factory is a dedicated workspace enhancement on the existing Prompt Lab route", async () => {
 const html = await read("index.html");
 const module = await read("modules/prompt-lab/prompt-lab.js");
 const css = await read("modules/prompt-lab/prompt-lab.css");
 assert.match(html, /modules\/prompt-lab\/prompt-lab\.js/);
 assert.match(html, /modules\/prompt-lab\/prompt-lab\.css/);
 assert.match(module, /Semantic IR/);
 assert.match(module, /initPromptLab\(\);/);
 assert.match(module, /lokal:ai-prompt-result/);
 assert.match(module, /factory-send-image/);
 assert.match(html, /action=conversation&id=/);
 assert.match(html, /requestBody\.image_urls=freshImageUrls/);
 assert.match(css, /prompt-factory-layout/);
});
test("Prompt Factory forwards private chat image IDs to the authenticated understanding endpoint", async () => {
 const html = await read("index.html");
 assert.match(html, /action=conversation&id=/);
 assert.match(html, /requestBody\.image_urls=freshImageUrls/);
});
test("Staging Prompt Intelligence allows the verified preview origin", async () => {
 const source = await read("supabase/staging/functions/prompt-understanding/index.ts");
 assert.match(source, /parsed\.hostname === "preview\.lokal-ai\.net"/);
});
test("Prompt Factory UI does not directly call generation, wallet, or provider endpoints", async () => {
 const module = await read("modules/prompt-lab/prompt-lab.js");
 assert.doesNotMatch(module, /fetch\s*\(/);
 assert.doesNotMatch(module, /generate_image|generate_video|wallet|ALPHA_API_KEY/i);
});
