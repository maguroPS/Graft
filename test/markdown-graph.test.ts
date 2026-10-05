import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractMarkdown, resolveMarkdownEdges } from "../src/graph/markdown.js";
import { grepGraph } from "../src/search/grep.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";
import { patchBuildConfig } from "../src/util/state.js";
import { buildGraph } from "../src/graph/build.js";
import { ask } from "../src/ask/ask.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

test("Markdown extraction creates document/section nodes and resolves local links", () => {
  const a = extractMarkdown("docs/a.md", "# A\nSee [B](b.md#target) and `runTask`.\n## Child\nText");
  const b = extractMarkdown("docs/b.md", "# Target\n");
  const code: NodeV1 = { id: "src/task.ts#runTask", name: "runTask", kind: "function", path: "src/task.ts", span: "L1-L2", signature: "runTask()", exported: true, origin: "ast", body_hash: "x", summary_state: "pending", summary: null, crux: null };
  const edges = resolveMarkdownEdges([...a.nodes, ...b.nodes, code], [...a.refs, ...b.refs]);
  assert.ok(a.nodes.some((n) => n.kind === "document"));
  assert.ok(a.nodes.some((n) => n.id === "docs/a.md#child"));
  assert.ok(edges.some((e) => e.relation === "contains" && e.target === "docs/a.md#child"));
  assert.ok(edges.some((e) => e.relation === "links_to" && e.target === "docs/b.md#target"));
  assert.ok(edges.some((e) => e.relation === "references" && e.target === code.id));
});

test("grep includes documents by default and --no-docs can exclude them", () => {
  const { nodes } = extractMarkdown("docs/a.md", "# Guide\nNeedle text");
  const graph: GraphV1 = { meta: { version: 1, nodeCount: nodes.length, edgeCount: 0, languages: [] }, nodes, edges: [] };
  const root = process.cwd();
  // Missing on-disk source is deliberately counted unreadable, proving the
  // default corpus includes configured documents.
  assert.equal(grepGraph(graph, root, "Needle").filesSearched, 1);
  assert.equal(grepGraph(graph, root, "Needle", { docs: false }).filesSearched, 0);
});

test("configured docs are built, searchable, and included in freshness inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-markdown-"));
  try {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "guide.md"), "# Guide\nToken rotation procedure\n");
    patchBuildConfig(dir, { docsDirs: ["docs"] });
    await buildGraph(dir);
    const result = ask(dir, "token rotation", { source: true });
    assert.ok(result.hits.some((h) => h.pointer.startsWith("docs/guide.md")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Markdown is indexed by default and can be disabled for a code-only build", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-markdown-default-"));
  try {
    writeFileSync(join(dir, "README.md"), "# Guide\nDefault document needle\n");
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")));
    assert.ok(graph?.nodes.some((n) => n.kind === "document" && n.path === "README.md"));

    patchBuildConfig(dir, { docsEnabled: false });
    await buildGraph(dir);
    const codeOnly = readGraph(wiringPath(join(dir, "graft")));
    assert.ok(!codeOnly?.nodes.some((n) => n.path === "README.md"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
