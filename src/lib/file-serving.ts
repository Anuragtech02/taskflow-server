/**
 * How a stored file is served back to the browser.
 *
 * Any file type can be uploaded, so serving is what keeps that safe. Files
 * are served from the API's own origin (where the session cookie is valid),
 * so an HTML or SVG file rendered there could run script as whoever opens it.
 * Therefore every response is nosniff'd and CSP-sandboxed (scripts can't run,
 * even in an SVG or HTML opened directly), and only formats that are safe and
 * useful to view in the browser are served inline — everything else downloads.
 */

type Policy = { contentType: string; inline: boolean; sandbox: boolean };

const INLINE: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  pdf: "application/pdf",
  // Text-like formats render as plain text — readable, never interpreted.
  txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", markdown: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8", json: "text/plain; charset=utf-8",
};

const DOWNLOAD: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", xml: "application/xml",
  zip: "application/zip", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  avi: "video/x-msvideo", mkv: "video/x-matroska",
};

export function servePolicy(name: string): Policy {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (INLINE[ext]) {
    // Chrome's built-in PDF viewer refuses to load in a sandboxed document;
    // a PDF can't script the API origin, so it's the one exemption.
    return { contentType: INLINE[ext], inline: true, sandbox: ext !== "pdf" };
  }
  return { contentType: DOWNLOAD[ext] ?? "application/octet-stream", inline: false, sandbox: true };
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(inline: boolean, filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Locks down any document the response could become. */
export const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
