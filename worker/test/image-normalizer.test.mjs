import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { normalizeImageForFlux } from "../src/image-normalizer.mjs";

test("downscales large images so both dimensions are below 512", async () => {
  const input = await sharp({
    create: {
      width: 1600,
      height: 900,
      channels: 3,
      background: { r: 24, g: 80, b: 120 },
    },
  }).jpeg().toBuffer();

  const result = await normalizeImageForFlux(input);
  const metadata = await sharp(result.bytes).metadata();

  assert.equal(result.mimeType, "image/png");
  assert.equal(result.extension, "png");
  assert.ok(metadata.width <= 511);
  assert.ok(metadata.height <= 511);
  assert.equal(metadata.width, 511);
  assert.equal(metadata.height, 287);
});

test("does not enlarge images that are already within the model limit", async () => {
  const input = await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 4,
      background: { r: 24, g: 80, b: 120, alpha: 0.5 },
    },
  }).png().toBuffer();

  const result = await normalizeImageForFlux(input);
  const metadata = await sharp(result.bytes).metadata();

  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 240);
  assert.equal(metadata.hasAlpha, true);
});

test("rejects invalid image bytes with a stable non-sensitive error", async () => {
  await assert.rejects(
    normalizeImageForFlux(Buffer.from("not an image")),
    { message: "IMAGE_EDIT_INPUT_DECODE_FAILED" },
  );
});
