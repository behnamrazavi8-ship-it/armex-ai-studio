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
