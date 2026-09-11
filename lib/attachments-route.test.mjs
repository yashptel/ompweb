import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { POST } = await jiti.import("../app/api/attachments/route.ts");

function withAgentDir(t) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-attachments-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

function uploadRequest(entries) {
  const formData = new FormData();
  for (const [name, blob] of entries) formData.append("file", blob, name);
  return new Request("http://localhost/api/attachments", { method: "POST", body: formData });
}

test("stores an upload under the agent uploads directory and keeps the display name", async (t) => {
  const agentDir = withAgentDir(t);

  const res = await POST(uploadRequest([
    ["report.pdf", new Blob(["%PDF-1.7 fake"], { type: "application/pdf" })],
  ]));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.files.length, 1);
  const [stored] = body.files;
  assert.equal(stored.name, "report.pdf");
  assert.equal(stored.mimeType, "application/pdf");
  assert.equal(stored.size, 13);
  assert.match(
    stored.path,
    new RegExp(`^${path.join(agentDir, "uploads").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${path.sep === "\\" ? "\\\\" : "/"}\\d{4}-\\d{2}-\\d{2}`),
  );
  assert.match(path.basename(stored.path), /^[0-9a-f]{12}-report\.pdf$/);
  assert.equal(fs.readFileSync(stored.path, "utf8"), "%PDF-1.7 fake");
});

test("sanitizes traversal names so the file lands inside the uploads directory", async (t) => {
  const agentDir = withAgentDir(t);
  const uploadsRoot = path.join(agentDir, "uploads");

  const res = await POST(uploadRequest([
    ["../../evil.sh", new Blob(["rm -rf /"], { type: "application/x-sh" })],
    ["..", new Blob(["dots"], { type: "application/octet-stream" })],
    ["spaces and #symbols!.txt", new Blob(["ok"], { type: "text/plain" })],
  ]));

  assert.equal(res.status, 200);
  const { files } = await res.json();
  assert.equal(files.length, 3);
  assert.deepEqual(files.map((file) => file.name), ["../../evil.sh", "..", "spaces and #symbols!.txt"]);

  for (const file of files) {
    assert.ok(file.path.startsWith(uploadsRoot + path.sep), `${file.path} escaped ${uploadsRoot}`);
    assert.equal(path.dirname(path.dirname(file.path)), uploadsRoot);
    assert.match(path.basename(file.path), /^[0-9a-f]{12}-[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.ok(fs.existsSync(file.path));
  }
  assert.match(path.basename(files[0].path), /-evil\.sh$/);
  assert.match(path.basename(files[1].path), /-attachment$/);
  assert.match(path.basename(files[2].path), /-spaces-and--symbols-\.txt$/);

  assert.equal(fs.existsSync(path.join(agentDir, "evil.sh")), false);
  assert.equal(fs.existsSync(path.join(os.tmpdir(), "evil.sh")), false);
  assert.deepEqual(fs.readdirSync(agentDir), ["uploads"]);
});

test("makes the uploads directory browsable through /api/files", async (t) => {
  withAgentDir(t);

  const res = await POST(uploadRequest([["a.pdf", new Blob(["x"], { type: "application/pdf" })]]));
  assert.equal(res.status, 200);

  const { getAllowedFileRoots, isFilePathAllowed } = await jiti.import("./file-access.ts");
  const roots = await getAllowedFileRoots();
  const { files } = await res.json();
  assert.equal(isFilePathAllowed(files[0].path, roots), true);
});

test("rejects a request with no file entries", async (t) => {
  withAgentDir(t);

  const res = await POST(new Request("http://localhost/api/attachments", { method: "POST", body: new FormData() }));

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "missing_files");
});

test("rejects a single attachment over 25MB", async (t) => {
  const agentDir = withAgentDir(t);

  const res = await POST(uploadRequest([
    ["huge.pdf", new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], { type: "application/pdf" })],
  ]));

  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.code, "attachment_file_too_large");
  assert.equal(fs.existsSync(path.join(agentDir, "uploads")), false);
});

test("rejects a wire body larger than the batch limit", async (t) => {
  withAgentDir(t);

  const res = await POST(new Request("http://localhost/api/attachments", {
    method: "POST",
    headers: {
      "content-length": String(100 * 1024 * 1024 + 1024 * 1024 + 1),
      "content-type": "multipart/form-data; boundary=---boundary",
    },
    body: "---boundary--\r\n",
  }));

  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.code, "attachment_total_too_large");
});
