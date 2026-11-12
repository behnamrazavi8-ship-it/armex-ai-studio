const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

const invalidImage = (code) => {
  const error = new Error(code);
  error.retryable = false;
  return error;
};

const detectImageFormat = (bytes) => {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
      bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
      bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mimeType: "image/png", extension: "png" };
  }

  if (bytes.length >= 3 &&
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }

  if (bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }

  throw invalidImage("UNSUPPORTED_IMAGE_FORMAT");
};

export function decodeCloudflareImageOutput(payload) {
  const imageBase64 = typeof payload?.result?.image === "string"
    ? payload.result.image
    : typeof payload?.image === "string" ? payload.image : "";

  if (!imageBase64 || imageBase64.length > MAX_BASE64_CHARS ||
      imageBase64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(imageBase64)) {
    throw invalidImage("INVALID_IMAGE_PROVIDER_RESPONSE");
  }

  const bytes = Buffer.from(imageBase64, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES ||
      bytes.toString("base64") !== imageBase64) {
    throw invalidImage("IMAGE_SIZE_LIMIT_OR_INVALID_BASE64");
  }

  return { bytes, ...detectImageFormat(bytes) };
}
