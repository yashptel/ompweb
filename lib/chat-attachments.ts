export const MAX_ATTACHED_TEXT_BYTES = 256 * 1024;
export const MAX_ATTACHED_TEXT_FILES = 10;

const TEXT_FILE_EXTENSIONS: Record<string, true> = {
  txt: true, text: true, md: true, markdown: true, mdx: true,
  csv: true, tsv: true, json: true, jsonl: true, ndjson: true,
  yaml: true, yml: true, toml: true, ini: true, cfg: true, conf: true, env: true,
  log: true, sql: true, xml: true, html: true, css: true, scss: true,
  js: true, jsx: true, ts: true, tsx: true, mjs: true, cjs: true,
  py: true, rb: true, go: true, rs: true, java: true, kt: true, swift: true,
  c: true, h: true, cpp: true, hpp: true, cs: true, php: true,
  sh: true, bash: true, zsh: true, fish: true, ps1: true,
  dockerfile: true, makefile: true, gitignore: true,
  diff: true, patch: true,
};

const TEXT_MIME_TYPES: Record<string, true> = {
  "application/json": true,
  "application/x-ndjson": true,
  "application/xml": true,
  "application/yaml": true,
  "application/toml": true,
  "application/x-sh": true,
};

export interface AttachedTextFileData {
  name: string;
  mimeType: string;
  content: string;
  size: number;
}

/** A file omp-web stored on disk instead of inlining. `path` is absolute. */
export interface AttachedDocumentData {
  name: string;
  path: string;
  size: number;
  mimeType: string;
}

function getFileExtension(name: string): string {
  return name.toLowerCase().replace(/\\/g, "/").split("/").pop()?.split(".").pop() ?? "";
}

export function isTextAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  const mimeType = (file.type ?? "").toLowerCase().split(";")[0].trim();
  if (mimeType.startsWith("text/")) return true;
  if (TEXT_MIME_TYPES[mimeType] === true) return true;
  return TEXT_FILE_EXTENSIONS[getFileExtension(file.name)] === true;
}

function languageForFile(name: string): string {
  const extension = getFileExtension(name);
  if (extension === "md" || extension === "markdown" || extension === "mdx") return "markdown";
  return "text";
}

function fenceForContent(content: string): string {
  const longestRun = content.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Inline text contents and point omp at stored documents, keeping the
 * attachment boundary clear. Documents stay paths: omp's `read` tool converts
 * pdf/docx/xlsx/pptx/epub itself, better than anything omp-web could extract. */
export function composeMessageWithAttachments(
  message: string,
  textFiles: AttachedTextFileData[],
  documents: AttachedDocumentData[],
): string {
  if (textFiles.length === 0 && documents.length === 0) return message;
  const blocks = textFiles.map((file) => {
    const fence = fenceForContent(file.content);
    return `Attached file: ${file.name}\n${fence}${languageForFile(file.name)}\n${file.content}\n${fence}`;
  });
  const documentLines = documents.map(
    (document) => `Attached file: ${document.name} — read it from ${document.path}`,
  );
  const parts = [message.trim(), ...blocks];
  if (documentLines.length > 0) parts.push(documentLines.join("\n"));
  return parts.filter(Boolean).join("\n\n");
}

export interface AttachmentReference {
  name: string;
  path: string;
}

const DOCUMENT_LINE = /^Attached file: (.+?) — read it from (\/.*|[A-Za-z]:[\\/].*)$/;

/**
 * Split the trailing document lines `composeMessageWithAttachments` appends
 * back off a stored message, so the transcript can show attachment chips
 * instead of the raw path the model needs.
 */
export function splitAttachmentReferences(text: string): { body: string; documents: AttachmentReference[] } {
  const lines = text.split("\n");
  const documents: AttachmentReference[] = [];
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (!line.trim()) {
      end -= 1;
      continue;
    }
    const match = DOCUMENT_LINE.exec(line);
    if (!match) break;
    documents.unshift({ name: match[1], path: match[2] });
    end -= 1;
  }
  if (documents.length === 0) return { body: text, documents: [] };
  return { body: lines.slice(0, end).join("\n").trimEnd(), documents };
}
