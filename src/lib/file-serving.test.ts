import { describe, expect, it } from "vitest";
import { contentDisposition, servePolicy } from "./file-serving.js";

describe("servePolicy", () => {
  it.each([
    ["page.html", "text/html; charset=utf-8", false, true],
    ["page.HTM", "text/html; charset=utf-8", false, true],
    ["logo.svg", "image/svg+xml", true, true],          // inline, but sandboxed: scripts can't run
    ["notes.md", "text/plain; charset=utf-8", true, true], // shown as text, never rendered
    ["data.json", "text/plain; charset=utf-8", true, true],
    ["photo.PNG", "image/png", true, true],
    ["clip.mp4", "video/mp4", true, true],
    ["spec.pdf", "application/pdf", true, false],       // Chrome's PDF viewer can't run sandboxed
    ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", false, true],
    ["tool.exe", "application/octet-stream", false, true],
    ["script.js", "application/octet-stream", false, true], // never served as JavaScript
    ["noextension", "application/octet-stream", false, true],
  ])("%s → %s, inline=%s, sandbox=%s", (name, type, inline, sandbox) => {
    expect(servePolicy(name)).toEqual({ contentType: type, inline, sandbox });
  });
});

describe("contentDisposition", () => {
  it("keeps a plain name", () => {
    expect(contentDisposition(false, "Q3 report.html")).toBe(`attachment; filename="Q3 report.html"; filename*=UTF-8''Q3%20report.html`);
  });
  it("neutralises quotes and non-ASCII in the fallback but keeps them in filename*", () => {
    const h = contentDisposition(true, 'résumé "final".pdf');
    expect(h.startsWith(`inline; filename="r_sum_ _final_.pdf"`)).toBe(true);
    expect(h).toContain(`filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`);
  });
  it("can't be used to inject extra header parameters", () => {
    expect(contentDisposition(false, 'x"; inline; filename="evil.html')).not.toContain('"; inline;');
  });
});
