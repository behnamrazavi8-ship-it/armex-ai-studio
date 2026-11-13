import { assertEquals } from "jsr:@std/assert";
import { validateRunpodVideoOutput, VIDEO_OUTPUT_MAX_BYTES } from "./video-output-policy.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const valid = {
  storage_path: userId + "/" + jobId + ".mp4",
  mime_type: "video/mp4",
  file_size_bytes: 12_345_678,
};

Deno.test("accepts only the deterministic per-user MP4 object for this job", () => {
  assertEquals(validateRunpodVideoOutput(valid, userId, jobId), {
    storagePath: valid.storage_path,
    mimeType: "video/mp4",
    fileSizeBytes: 12_345_678,
  });
});

Deno.test("rejects provider URLs instead of treating them as durable output", () => {
  assertEquals(validateRunpodVideoOutput({
    video_url: "https://temporary.runpod.net/video.mp4",
    url: "https://cdn.example/video.mp4",
  }, userId, jobId), null);
});

Deno.test("rejects path traversal and cross-user object paths", () => {
  assertEquals(validateRunpodVideoOutput({
    ...valid, storage_path: "../" + jobId + ".mp4",
  }, userId, jobId), null);
  assertEquals(validateRunpodVideoOutput({
    ...valid, storage_path: "33333333-3333-4333-8333-333333333333/" + jobId + ".mp4",
  }, userId, jobId), null);
});

Deno.test("rejects incorrect content type and empty or oversized files", () => {
  assertEquals(validateRunpodVideoOutput({ ...valid, mime_type: "video/webm" }, userId, jobId), null);
  assertEquals(validateRunpodVideoOutput({ ...valid, file_size_bytes: 0 }, userId, jobId), null);
  assertEquals(validateRunpodVideoOutput({
    ...valid, file_size_bytes: VIDEO_OUTPUT_MAX_BYTES + 1,
  }, userId, jobId), null);
});

Deno.test("rejects malformed metadata and non-integer file sizes", () => {
  assertEquals(validateRunpodVideoOutput(null, userId, jobId), null);
  assertEquals(validateRunpodVideoOutput([], userId, jobId), null);
  assertEquals(validateRunpodVideoOutput({ ...valid, file_size_bytes: "12345" }, userId, jobId), null);
  assertEquals(validateRunpodVideoOutput({ ...valid, file_size_bytes: 1.5 }, userId, jobId), null);
});


Deno.test("maps only the aspect ratios supported by Wan2.2 TI2V-5B", async () => {
  const { wanSizeForAspectRatio } = await import("./video-output-policy.ts");
  assertEquals(wanSizeForAspectRatio("16:9"), "1280*704");
  assertEquals(wanSizeForAspectRatio("9:16"), "704*1280");
  assertEquals(wanSizeForAspectRatio("1:1"), null);
  assertEquals(wanSizeForAspectRatio("4:3"), null);
});
