import sharp from "sharp";

const MAX_DIMENSION = 511;
const MAX_INPUT_PIXELS = 40_000_000;

export async function normalizeImageForFlux(inputBytes) {
  if (!(inputBytes instanceof Uint8Array) || inputBytes.byteLength === 0) {
    throw new Error("IMAGE_EDIT_INPUT_DECODE_FAILED");
  }

  try {
    const { data, info } = await sharp(inputBytes, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
    })
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 6 })
      .toBuffer({ resolveWithObject: true });

    if (
      !data.length ||
      info.width < 1 ||
      info.height < 1 ||
      info.width > MAX_DIMENSION ||
      info.height > MAX_DIMENSION
    ) {
      throw new Error("IMAGE_EDIT_INPUT_DIMENSIONS_INVALID");
    }

    return {
      bytes: data,
      mimeType: "image/png",
      extension: "png",
      width: info.width,
      height: info.height,
    };
  } catch {
    throw new Error("IMAGE_EDIT_INPUT_DECODE_FAILED");
  }
}
