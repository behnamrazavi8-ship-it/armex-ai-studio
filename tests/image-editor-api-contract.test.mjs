import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  friendlyImageEditError,
  readImageEditHistory,
  readImageEditJob,
  readImageEditQuota,
} from "../modules/image-editor/image-editor.js";

test("quota response must be a real image-editor quota, not generic API health", () => {
  assert.deepEqual(readImageEditQuota({
    success: true, used: 2, limit: 5, remaining: 3,
  }), { used: 2, limit: 5, remaining: 3 });
  assert.throws(
    () => readImageEditQuota({ success: true, service: "LOKAL AI", status: "online" }),
    /IMAGE_EDIT_API_NOT_READY/,
  );
  assert.throws(
    () => readImageEditQuota({ success: true, used: 1, limit: 5, remaining: 5 }),
    /IMAGE_EDIT_API_NOT_READY/,
  );
});

test("history and job polling reject generic online responses", () => {
  assert.deepEqual(readImageEditHistory({ success: true, edits: [] }), []);
  assert.throws(() => readImageEditHistory({ success: true, service: "LOKAL AI" }), /IMAGE_EDIT_API_NOT_READY/);
  assert.equal(readImageEditJob({ success: true, job: { status: "queued" } }).status, "queued");
  assert.throws(() => readImageEditJob({ success: true, status: "online" }), /IMAGE_EDIT_API_NOT_READY/);
  assert.match(friendlyImageEditError(new Error("IMAGE_EDIT_API_NOT_READY")), /Migration/);
});

test("image editor API, migration and Weblines coordinator share the same queue contract", async () => {
  const [api, migration, worker, docs] = await Promise.all([
    readFile(new URL("../supabase/functions/armex-api/image-edit-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20261116010000_lokal_image_edit_free_quota.sql", import.meta.url), "utf8"),
    readFile(new URL("../worker/src/worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/IMAGE_EDITING_ENGINE.md", import.meta.url), "utf8"),
  ]);
  assert.match(api, /handleImageEditApi/);
  assert.match(api, /armex_enqueue_image_edit/);
  assert.match(migration, /armex_claim_image_edit_job/);
  assert.match(migration, /armex_complete_image_edit_job/);
  assert.match(worker, /processImageEditJob/);
  assert.match(worker, /input_image_0/);
  assert.match(worker, /armex_claim_image_edit_job/);
  assert.match(docs, /Weblines/);
  assert.match(docs, /does not apply migrations, deploy/);
});
