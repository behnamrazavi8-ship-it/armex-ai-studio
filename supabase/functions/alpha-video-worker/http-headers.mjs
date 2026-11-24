const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function parsePinnedHttpHeaders(raw) {
  const lines = raw.split("\r\n");
  const statusLine = lines.shift() || "";
  const statusMatch = /^HTTP\/1\.[01] (\d{3})(?: [\x20-\x7e]*)?$/.exec(statusLine);
  if (!statusMatch) throw new Error("pinned_http_invalid_status_line");
  const status = Number(statusMatch[1]);
  if (status < 200 || status > 599) throw new Error("pinned_http_unsupported_status");

  const headers = new Headers();
  const seen = new Set();
  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line)) throw new Error("pinned_http_folded_header_rejected");
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("pinned_http_invalid_header");
    const name = line.slice(0, colon);
    if (!TOKEN.test(name)) throw new Error("pinned_http_invalid_header_name");
    const lower = name.toLowerCase();
    if (seen.has(lower) && ["content-length", "content-encoding", "transfer-encoding"].includes(lower)) {
      throw new Error("pinned_http_duplicate_framing_header");
    }
    seen.add(lower);
    const value = line.slice(colon + 1).trim();
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new Error("pinned_http_invalid_header_value");
    headers.append(name, value);
  }

  if (headers.has("transfer-encoding")) throw new Error("pinned_http_transfer_encoding_unsupported");
  const encoding = headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    throw new Error("pinned_http_unexpected_content_encoding");
  }
  const lengthHeader = headers.get("content-length");
  let contentLength = null;
  if (lengthHeader !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(lengthHeader)) {
      throw new Error("pinned_http_invalid_content_length");
    }
    contentLength = Number(lengthHeader);
    if (!Number.isSafeInteger(contentLength)) throw new Error("pinned_http_invalid_content_length");
  }
  return { status, headers, contentLength };
}
