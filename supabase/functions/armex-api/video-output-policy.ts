export const VIDEO_OUTPUT_MAX_BYTES = 50 * 1024 * 1024;

export type DurableVideoOutput = {
  storagePath: string;
  mimeType: "video/mp4";
  fileSizeBytes: number;
};

/**
 * Accept only the deterministic private Storage object assigned to this job.
 * Provider-supplied URLs are deliberately not accepted as durable results.
 */
export const validateRunpodVideoOutput = (
  output: unknown,
  userId: string,
  jobId: string,
): DurableVideoOutput | null => {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const value = output as Record<string, unknown>;
  const expectedPath = userId + "/" + jobId + ".mp4";
  if (value.storage_path !== expectedPath || value.mime_type !== "video/mp4") return null;
  const fileSizeBytes = value.file_size_bytes;
  if (typeof fileSizeBytes !== "number" || !Number.isSafeInteger(fileSizeBytes) ||
      fileSizeBytes < 1 || fileSizeBytes > VIDEO_OUTPUT_MAX_BYTES) return null;
  return { storagePath: expectedPath, mimeType: "video/mp4", fileSizeBytes };
};


/** Wan2.2 TI2V-5B official inference supports these two sizes only. */
export const wanSizeForAspectRatio = (aspectRatio: unknown): "1280*704" | "704*1280" | null => {
  if (aspectRatio === "16:9") return "1280*704";
  if (aspectRatio === "9:16") return "704*1280";
  return null;
};
