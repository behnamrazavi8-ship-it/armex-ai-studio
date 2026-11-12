import { createHash } from "node:crypto";

export function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function promptFingerprint(prompt) {
  const value = typeof prompt === "string" ? prompt : "";
  return { length: value.length, sha256: hashBytes(Buffer.from(value, "utf8")) };
}
