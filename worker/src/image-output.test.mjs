import test from "node:test";
import assert from "node:assert/strict";
import { decodeCloudflareImageOutput } from "./image-output.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

test("detects PNG and preserves the correct storage content type", () => {
  const pngHeader = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
  const output = decodeCloudflareImageOutput({ result: { image: b64(pngHeader) } });
  assert.equal(output.mimeType, "image/png");
  assert.equal(output.extension, "png");
  assert.deepEqual(output.bytes, pngHeader);
});

test("detects JPEG", () => {
  const bytes = Buffer.from([0xff,0xd8,0xff,0xd9]);
  const output = decodeCloudflareImageOutput({ image: b64(bytes) });
  assert.equal(output.mimeType, "image/jpeg");
  assert.equal(output.extension, "jpg");
});

test("detects WebP", () => {
  const bytes = Buffer.from("RIFF0000WEBP", "ascii");
  const output = decodeCloudflareImageOutput({ result: { image: b64(bytes) } });
  assert.equal(output.mimeType, "image/webp");
  assert.equal(output.extension, "webp");
});

test("rejects missing, malformed, and unsupported image data", () => {
  assert.throws(() => decodeCloudflareImageOutput({}), { message: "INVALID_IMAGE_PROVIDER_RESPONSE" });
  assert.throws(() => decodeCloudflareImageOutput({ image: "not-base64!" }), { message: "INVALID_IMAGE_PROVIDER_RESPONSE" });
  assert.throws(() => decodeCloudflareImageOutput({ image: b64(Buffer.from("text")) }), { message: "UNSUPPORTED_IMAGE_FORMAT" });
});
