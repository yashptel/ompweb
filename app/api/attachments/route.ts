import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import type { AttachedDocumentData } from "@/lib/chat-attachments";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { allowFileRoot } from "@/lib/file-access";
import { getAgentDir } from "@/lib/omp/paths";

export const dynamic = "force-dynamic";

const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024;
// Multipart boundaries and headers are not file bytes, but must be bounded too.
const MAX_ATTACHMENT_REQUEST_BYTES = MAX_ATTACHMENT_TOTAL_BYTES + 1024 * 1024;
const MAX_STORED_NAME_LENGTH = 96;
const TOO_LARGE_TOTAL = { error: "Attachments must total 100MB or less", code: "attachment_total_too_large" } as const;

function sanitizeStoredName(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, "/"));
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, MAX_STORED_NAME_LENGTH);
  return safe || "attachment";
}

export async function POST(request: Request) {
  try {
    let formData: FormData;
    try {
      formData = await parseFormDataWithinLimit(request, MAX_ATTACHMENT_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return NextResponse.json(TOO_LARGE_TOTAL, { status: 413 });
      throw error;
    }

    const files = formData.getAll("file").filter((entry): entry is File => typeof entry !== "string");
    if (files.length === 0) {
      return NextResponse.json({ error: "At least one file is required", code: "missing_files" }, { status: 400 });
    }
    if (files.some((file) => file.size > MAX_ATTACHMENT_FILE_BYTES)) {
      return NextResponse.json(
        { error: "Each attachment must be 25MB or smaller", code: "attachment_file_too_large" },
        { status: 413 },
      );
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_TOTAL_BYTES) {
      return NextResponse.json(TOO_LARGE_TOTAL, { status: 413 });
    }

    const uploadsRoot = path.resolve(getAgentDir(), "uploads");
    const dayDirectory = path.join(uploadsRoot, new Date().toISOString().slice(0, 10));
    await mkdir(dayDirectory, { recursive: true });

    const stored: AttachedDocumentData[] = [];
    for (const file of files) {
      const storedName = `${randomBytes(6).toString("hex")}-${sanitizeStoredName(file.name)}`;
      const destination = path.resolve(dayDirectory, storedName);
      if (!destination.startsWith(uploadsRoot + path.sep)) {
        return NextResponse.json({ error: `Invalid file name: ${file.name}`, code: "invalid_file_name" }, { status: 400 });
      }
      await writeFile(destination, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
      stored.push({
        name: file.name || storedName,
        path: destination,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
      });
    }

    // /api/files is allow-list gated, so the composer cannot preview what it
    // just uploaded until the uploads root is browsable.
    allowFileRoot(uploadsRoot);

    return NextResponse.json({ files: stored });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
