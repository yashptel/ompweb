import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./chat-attachments.ts");
}

function textFile(name, type = "") {
  return { name, type };
}

test("recognizes text-shaped attachments by mime or extension", async () => {
  const { isTextAttachmentFile } = await loadSubject();

  assert.equal(isTextAttachmentFile(textFile("notes.txt", "text/plain")), true);
  assert.equal(isTextAttachmentFile(textFile("README.md", "text/markdown")), true);
  assert.equal(isTextAttachmentFile(textFile("README.MD")), true);
  assert.equal(isTextAttachmentFile(textFile("page.mdx")), true);
  assert.equal(isTextAttachmentFile(textFile("rows.csv", "text/csv")), true);
  assert.equal(isTextAttachmentFile(textFile("rows.CSV")), true);
  assert.equal(isTextAttachmentFile(textFile("data.json", "application/json")), true);
  assert.equal(isTextAttachmentFile(textFile("data.json")), true);
  assert.equal(isTextAttachmentFile(textFile("module.ts")), true);
  assert.equal(isTextAttachmentFile(textFile("Dockerfile")), true);
  assert.equal(isTextAttachmentFile(textFile("Makefile")), true);
  assert.equal(isTextAttachmentFile(textFile(".gitignore")), true);
  assert.equal(isTextAttachmentFile(textFile("config.yml", "application/octet-stream")), true);
  assert.equal(isTextAttachmentFile(textFile("notes.txt", "text/plain; charset=utf-8")), true);

  assert.equal(isTextAttachmentFile(textFile("report.pdf", "application/pdf")), false);
  assert.equal(isTextAttachmentFile(textFile("image.png", "image/png")), false);
  assert.equal(
    isTextAttachmentFile(textFile("book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")),
    false,
  );
  assert.equal(isTextAttachmentFile(textFile("noextension")), false);
});

test("returns the message untouched when nothing is attached", async () => {
  const { composeMessageWithAttachments } = await loadSubject();

  assert.equal(composeMessageWithAttachments("hello", [], []), "hello");
});

test("composes text attachment blocks and grows the fence past triple backticks", async () => {
  const { composeMessageWithAttachments } = await loadSubject();

  const result = composeMessageWithAttachments("  ", [
    { name: "notes.txt", mimeType: "text/plain", content: "line one", size: 8 },
  ], []);
  assert.equal(result, "Attached file: notes.txt\n```text\nline one\n```");

  const backticks = composeMessageWithAttachments("", [
    { name: "README.md", mimeType: "text/markdown", content: "```js\ncode\n```", size: 15 },
  ], []);
  assert.equal(backticks, "Attached file: README.md\n````markdown\n```js\ncode\n```\n````");
});

test("keeps message text above attachment blocks", async () => {
  const { composeMessageWithAttachments } = await loadSubject();

  const result = composeMessageWithAttachments("Review this", [
    { name: "a.md", mimeType: "text/markdown", content: "A", size: 1 },
    { name: "b.txt", mimeType: "text/plain", content: "B", size: 1 },
  ], []);

  assert.ok(result.startsWith("Review this\n\nAttached file: a.md"));
  assert.equal(result.includes("Attached file: b.md"), false);
  assert.ok(result.includes("Attached file: b.txt"));
});

test("points omp at stored documents by absolute path", async () => {
  const { composeMessageWithAttachments } = await loadSubject();

  const documentsOnly = composeMessageWithAttachments("", [], [
    { name: "report.pdf", path: "/home/a/.omp/agent/uploads/2026-09-10/ab12-report.pdf", size: 10, mimeType: "application/pdf" },
    { name: "book.xlsx", path: "/home/a/.omp/agent/uploads/2026-09-10/cd34-book.xlsx", size: 20, mimeType: "application/vnd.ms-excel" },
  ]);
  assert.equal(
    documentsOnly,
    "Attached file: report.pdf — read it from /home/a/.omp/agent/uploads/2026-09-10/ab12-report.pdf\n"
    + "Attached file: book.xlsx — read it from /home/a/.omp/agent/uploads/2026-09-10/cd34-book.xlsx",
  );
});

test("orders message, text blocks, then document paths", async () => {
  const { composeMessageWithAttachments } = await loadSubject();

  const result = composeMessageWithAttachments("Compare these", [
    { name: "rows.csv", mimeType: "text/csv", content: "a,b\n1,2", size: 7 },
  ], [
    { name: "report.pdf", path: "/uploads/2026-09-10/ab12-report.pdf", size: 10, mimeType: "application/pdf" },
  ]);

  assert.equal(
    result,
    "Compare these\n\n"
    + "Attached file: rows.csv\n```text\na,b\n1,2\n```\n\n"
    + "Attached file: report.pdf — read it from /uploads/2026-09-10/ab12-report.pdf",
  );
});

test("attachment reference lines split off the message body", async () => {
  const { composeMessageWithAttachments, splitAttachmentReferences } = await import("./chat-attachments.ts");
  const documents = [
    { name: "ACK1.pdf", path: "/Users/x/.omp/agent/uploads/2026-09-10/ab12-ACK1.pdf", size: 10, mimeType: "application/pdf" },
    { name: "book.xlsx", path: "/Users/x/.omp/agent/uploads/2026-09-10/cd34-book.xlsx", size: 20, mimeType: "application/vnd.ms-excel" },
  ];
  const composed = composeMessageWithAttachments("what is in this?", [], documents);
  const split = splitAttachmentReferences(composed);
  assert.equal(split.body, "what is in this?");
  assert.deepEqual(split.documents, documents.map(({ name, path }) => ({ name, path })));

  // Prose that merely mentions an attachment must survive untouched.
  const prose = "Attached file: notes.txt was helpful";
  assert.deepEqual(splitAttachmentReferences(prose), { body: prose, documents: [] });
  // Only trailing lines count; a reference mid-message stays in the body.
  const middle = `${composed}\n\ntrailing question?`;
  assert.deepEqual(splitAttachmentReferences(middle), { body: middle, documents: [] });
});
