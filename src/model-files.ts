import type { ModelConfig } from "./config.js";
import type { SlackFile } from "./slack-files.js";

type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";
type BinaryMimeType = "application/pdf" | ImageMimeType;

export type ModelFile =
  | { kind: "text"; text: string }
  | { kind: "pdf"; name: string; data: string }
  | { kind: "image"; mimeType: ImageMimeType; data: string };

const textMimeTypes = new Set([
  "text/plain", "text/markdown", "text/x-markdown", "text/csv", "text/tab-separated-values", "application/json",
]);
const maxTextBytes = 64 * 1024;
const maxClaudeImageBytes = 7_500_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const pdfHeader = Buffer.from("%PDF-");
const jpegHeader = Buffer.from([0xff, 0xd8, 0xff]);
const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function matchesFileHeader(mimeType: BinaryMimeType, bytes: Buffer): boolean {
  switch (mimeType) {
    case "application/pdf":
      return bytes.subarray(0, pdfHeader.length).equals(pdfHeader);
    case "image/jpeg":
      return bytes.subarray(0, jpegHeader.length).equals(jpegHeader);
    case "image/png":
      return bytes.subarray(0, pngHeader.length).equals(pngHeader);
    case "image/webp":
      return bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
  }
}

export function prepareModelFiles(files: readonly SlackFile[], provider: ModelConfig["provider"]):
  { parts: ModelFile[] } | { message: string } {
  const parts: ModelFile[] = [];
  let textBytes = 0;
  for (const { name, mimeType, bytes } of files) {
    if (!bytes.byteLength) {
      return { message: `"${name}" is empty. Attach a file with content and try again.` };
    }
    if (textMimeTypes.has(mimeType)) {
      textBytes += bytes.byteLength;
      if (textBytes > maxTextBytes) {
        return { message: "Keep text attachments to 64 KiB in total and try again." };
      }
      let text: string;
      try {
        text = utf8.decode(bytes);
      } catch {
        return { message: `Save "${name}" as UTF-8 text and try again.` };
      }
      if (!text.trim() || text.includes("\0")) {
        return { message: `"${name}" needs readable UTF-8 text. Check the file and try again.` };
      }
      parts.push({ kind: "text", text: `File: ${name}\n${text}` });
      continue;
    }
    if (mimeType !== "application/pdf" && mimeType !== "image/jpeg" &&
        mimeType !== "image/png" && mimeType !== "image/webp") {
      return { message: `I can't read "${name}" in that format. Attach a PDF, JPEG, PNG, WebP, or UTF-8 text file.` };
    }
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!matchesFileHeader(mimeType, buffer)) {
      return { message: `"${name}" does not match its file format. Save the file again and try again.` };
    }
    // Claude limits each image to 10 MB after base64 encoding.
    if (mimeType !== "application/pdf" && provider === "claude" && buffer.length > maxClaudeImageBytes) {
      return { message: `"${name}" is too large for Claude. Use an image of 7.5 MB or less.` };
    }
    const data = buffer.toString("base64");
    if (mimeType === "application/pdf") parts.push({ kind: "pdf", name, data });
    else parts.push({ kind: "image", mimeType, data });
  }
  return { parts };
}
