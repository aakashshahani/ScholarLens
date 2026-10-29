/**
 * Escape text for interpolation into an HTML string. Use it for every value
 * that originates from the backend before building markup by hand — analysis
 * text, claims and hypotheses are LLM output derived from user-uploaded PDFs,
 * so they must be treated as untrusted.
 */
export function escapeHtml(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
