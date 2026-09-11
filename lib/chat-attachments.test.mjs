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

test("selects attachments under the per-file and aggregate budgets", async () => {
  const { selectTextAttachments, MAX_ATTACHED_TEXT_BYTES, MAX_TOTAL_ATTACHED_TEXT_BYTES } = await loadSubject();
  const file = (name, size) => ({ name, size });

  // A lone file may fill the whole budget, and 8x the old 256 KB cap fits.
  const large = selectTextAttachments([file("big.log", 2 * 1024 * 1024)], { usedBytes: 0, usedSlots: 0 });
  assert.deepEqual(large.accepted.map((f) => f.name), ["big.log"]);
  assert.equal(large.tooLarge, 0);
  assert.equal(large.overBudget, 0);
  assert.equal(MAX_ATTACHED_TEXT_BYTES, MAX_TOTAL_ATTACHED_TEXT_BYTES);

  // Past the per-file cap the file is refused for its own size, not the budget.
  const oversized = selectTextAttachments([file("huge.log", MAX_ATTACHED_TEXT_BYTES + 1)], { usedBytes: 0, usedSlots: 0 });
  assert.deepEqual(oversized.accepted, []);
  assert.equal(oversized.tooLarge, 1);
  assert.equal(oversized.overBudget, 0);

  // The aggregate budget counts what the composer already holds, and files
  // that no longer fit are reported separately from oversized ones.
  const partial = selectTextAttachments(
    [file("fits.txt", 1024 * 1024), file("over.txt", 2 * 1024 * 1024), file("huge.log", MAX_ATTACHED_TEXT_BYTES + 1)],
    { usedBytes: 3 * 1024 * 1024, usedSlots: 1 },
  );
  assert.deepEqual(partial.accepted.map((f) => f.name), ["fits.txt"]);
  assert.equal(partial.tooLarge, 1);
  assert.equal(partial.overBudget, 1);

  // Remaining file slots cap the batch even when every file fits.
  const slots = selectTextAttachments([file("a.txt", 1), file("b.txt", 1)], { usedBytes: 0, usedSlots: 9 });
  assert.deepEqual(slots.accepted.map((f) => f.name), ["a.txt"]);
  assert.equal(slots.tooLarge, 0);
  assert.equal(slots.overBudget, 0);
});

test("skip banners name the limit the batch actually hit", async () => {
  const { describeTextAttachmentSkip, formatAttachmentBytes } = await loadSubject();

  assert.equal(formatAttachmentBytes(512 * 1024), "512 KB");
  assert.equal(formatAttachmentBytes(4 * 1024 * 1024), "4 MB");
  assert.equal(describeTextAttachmentSkip({ tooLarge: 0, overBudget: 0 }), null);
  assert.equal(
    describeTextAttachmentSkip({ tooLarge: 2, overBudget: 1 }),
    "2 file(s) skipped: files up to 4 MB are supported.",
  );
  assert.equal(
    describeTextAttachmentSkip({ tooLarge: 0, overBudget: 3 }),
    "3 file(s) skipped: attachments are limited to 4 MB per message.",
  );
});
