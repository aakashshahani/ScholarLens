/**
 * Save a Blob as a file. The object URL is revoked on the next tick, not
 * synchronously after click() — revoking immediately can cancel the download
 * in Firefox and Safari.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
