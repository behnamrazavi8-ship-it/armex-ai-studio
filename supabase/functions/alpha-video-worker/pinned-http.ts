const MAX_HEADER_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 50 * 1024 * 1024;

export function isPublicIpv4(raw: string): boolean {
  const parts = raw.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b, c] = parts.map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255) return false;
  return true;
}

function findHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i <= bytes.length - 4; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i + 4;
  }
  return -1;
}

function parseHeaders(raw: string): { status: number; headers: Headers } {
  const lines = raw.split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines.shift() || "");
  if (!statusMatch) throw new Error("pinned_http_invalid_status_line");
  const headers = new Headers();
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("pinned_http_invalid_header");
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    headers.append(name, value);
  }
  return { status: Number(statusMatch[1]), headers };
}

async function resolvePinnedIpv4(host: string): Promise<string[]> {
  let a: string[];
  let aaaa: string[];
  try {
    [a, aaaa] = await Promise.all([
      Deno.resolveDns(host, "A"),
      Deno.resolveDns(host, "AAAA"),
    ]);
  } catch {
    throw new Error("provider_output_dns_resolution_failed");
  }
  if (!a.length || aaaa.length || a.some((ip) => !isPublicIpv4(ip))) {
    throw new Error("provider_output_dns_not_public_ipv4_only");
  }
  return [...new Set(a)];
}

async function connectPinned(ip: string, host: string): Promise<Deno.TlsConn> {
  const tcp = await Deno.connect({ hostname: ip, port: 443, transport: "tcp" });
  try {
    const peer = tcp.remoteAddr;
    if (peer.transport !== "tcp" || peer.hostname !== ip) {
      throw new Error("provider_output_peer_ip_mismatch");
    }
    // TCP is opened to the already-validated literal IP. TLS still uses the
    // original hostname for SNI and certificate hostname verification.
    return await Deno.startTls(tcp, { hostname: host });
  } catch (error) {
    tcp.close();
    throw error;
  }
}

export async function fetchPinnedHttps(rawUrl: string): Promise<Response> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password) {
    throw new Error("provider_output_url_rejected");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const ips = await resolvePinnedIpv4(host);
  let lastError: unknown;
  for (const ip of ips) {
    let tls: Deno.TlsConn | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      tls = await connectPinned(ip, host);
      const socket = tls;
      const abortSocket = () => socket.close();
      timer = setTimeout(abortSocket, 30000);
      const writer = socket.writable.getWriter();
      const request = [
        `GET ${url.pathname || "/"}${url.search} HTTP/1.1`,
        `Host: ${host}`,
        "Accept: video/mp4, application/octet-stream;q=0.9, */*;q=0.1",
        "Accept-Encoding: identity",
        "Connection: close",
        "User-Agent: LOKAL-AI-Video-Worker/1.0",
        "",
        "",
      ].join("\r\n");
      await writer.write(new TextEncoder().encode(request));
      writer.releaseLock();

      const reader = socket.readable.getReader();
      const headerParts: Uint8Array[] = [];
      let headerBytes = 0;
      let headerEnd = -1;
      let initialBody = new Uint8Array();
      while (headerEnd < 0) {
        const { done, value } = await reader.read();
        if (done || !value) throw new Error("pinned_http_headers_incomplete");
        headerParts.push(value);
        headerBytes += value.byteLength;
        if (headerBytes > MAX_HEADER_BYTES) throw new Error("pinned_http_headers_too_large");
        const combined = new Uint8Array(headerBytes);
        let offset = 0;
        for (const part of headerParts) { combined.set(part, offset); offset += part.byteLength; }
        headerEnd = findHeaderEnd(combined);
        if (headerEnd >= 0) {
          const decoder = new TextDecoder("latin1");
          const parsed = parseHeaders(decoder.decode(combined.subarray(0, headerEnd - 4)));
          initialBody = combined.slice(headerEnd);
          const encoding = parsed.headers.get("content-encoding");
          if (encoding && encoding.toLowerCase() !== "identity") throw new Error("pinned_http_unexpected_content_encoding");
          const transferEncoding = parsed.headers.get("transfer-encoding");
          if (transferEncoding) throw new Error("pinned_http_transfer_encoding_unsupported");
          const lengthHeader = parsed.headers.get("content-length");
          const contentLength = lengthHeader === null ? null : Number(lengthHeader);
          if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES)) {
            throw new Error("video_output_too_large");
          }
          if ([301, 302, 303, 307, 308].includes(parsed.status) || [204, 304].includes(parsed.status) || contentLength === 0) {
            reader.cancel().catch(() => {});
            socket.close();
            clearTimeout(timer);
            timer = undefined;
            return new Response(null, { status: parsed.status, headers: parsed.headers });
          }
          if (initialBody.byteLength > MAX_BODY_BYTES || contentLength !== null && initialBody.byteLength > contentLength) {
            throw new Error("video_output_too_large");
          }
          let sentInitial = false;
          let sent = 0;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                if (!sentInitial) {
                  sentInitial = true;
                  if (initialBody.byteLength) {
                    const first = contentLength === null ? initialBody : initialBody.subarray(0, contentLength);
                    sent += first.byteLength;
                    controller.enqueue(first);
                    if (contentLength !== null && sent === contentLength) {
                      controller.close();
                      reader.cancel().catch(() => {});
                      socket.close();
                      if (timer !== undefined) clearTimeout(timer);
                      return;
                    }
                    return;
                  }
                }
                const next = await reader.read();
                if (next.done || !next.value) {
                  if (contentLength !== null && sent !== contentLength) throw new Error("pinned_http_body_length_mismatch");
                  controller.close();
                  socket.close();
                  if (timer !== undefined) clearTimeout(timer);
                  return;
                }
                let chunk = next.value;
                if (contentLength !== null) {
                  const remaining = contentLength - sent;
                  if (chunk.byteLength > remaining) chunk = chunk.subarray(0, remaining);
                }
                sent += chunk.byteLength;
                if (sent > MAX_BODY_BYTES) throw new Error("video_output_too_large");
                controller.enqueue(chunk);
                if (contentLength !== null && sent === contentLength) {
                  controller.close();
                  reader.cancel().catch(() => {});
                  socket.close();
                  if (timer !== undefined) clearTimeout(timer);
                }
              } catch (error) {
                controller.error(error);
                socket.close();
                if (timer !== undefined) clearTimeout(timer);
              }
            },
            async cancel() {
              await reader.cancel().catch(() => {});
              socket.close();
              if (timer !== undefined) clearTimeout(timer);
            },
          });
          return new Response(body, { status: parsed.status, headers: parsed.headers });
        }
      }
      throw new Error("pinned_http_headers_incomplete");
    } catch (error) {
      lastError = error;
      if (tls) tls.close();
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("provider_output_pinned_connect_failed");
}
