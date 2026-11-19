import test from "node:test";
import assert from "node:assert/strict";
import { getImageEditInputPaths } from "./image-edit-inputs.mjs";

const userId = "9ed2a00a-6929-4440-b35f-f8c186d5f116";

test("keeps the legacy single input path compatible", () => {
  assert.deepEqual(getImageEditInputPaths({
    user_id: userId,
    input_storage_path: userId + "/edit/one.webp",
  }), [userId + "/edit/one.webp"]);
});

test("accepts up to three ordered reference images", () => {
  const paths = [0, 1, 2].map((n) => userId + "/edit/" + n + ".webp");
  assert.deepEqual(getImageEditInputPaths({ user_id: userId, input_storage_paths: paths }), paths);
});

test("rejects more than three reference images", () => {
  const paths = [0, 1, 2, 3].map((n) => userId + "/edit/" + n + ".webp");
  assert.throws(() => getImageEditInputPaths({ user_id: userId, input_storage_paths: paths }));
});

test("rejects paths outside the authenticated user's edit folder", () => {
  assert.throws(() => getImageEditInputPaths({
    user_id: userId,
    input_storage_paths: [userId + "/edit/one.webp", "other-user/edit/two.webp"],
  }));
});

test("rejects path traversal segments", () => {
  assert.throws(() => getImageEditInputPaths({
    user_id: userId,
    input_storage_paths: [userId + "/edit/../private.webp"],
  }));
});
