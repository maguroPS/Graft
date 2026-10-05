/** Deterministic Markdown document extraction. Deliberately small: headings and
 * explicit links are durable structure; prose is retrieval text, not an edge. */
import { posix } from "node:path";
import matter from "gray-matter";
import { contentHash } from "../util/id.js";
import type { EdgeV1, NodeV1 } from "./types.js";

export interface MarkdownRef { source: string; target: string; kind: "contains" | "link" | "code"; }

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[`*_~]/g, "").replace(/[^a-z0-9 _-]/g, "").replace(/[ _]+/g, "-").replace(/-+/g, "-") || "section";
}

function span(start: number, end: number): string { return `L${start}-L${end}`; }

/** Extract a document plus its ATX heading sections. */
export function extractMarkdown(path: string, source: string): { nodes: NodeV1[]; refs: MarkdownRef[] } {
  const lines = source.split("\n");
  const headings: Array<{ line: number; level: number; title: string; anchor: string }> = [];
  const used = new Map<string, number>();
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) return;
    const base = slug(m[2]); const n = used.get(base) ?? 0; used.set(base, n + 1);
    headings.push({ line: i + 1, level: m[1].length, title: m[2].trim(), anchor: n ? `${base}-${n}` : base });
  });
  const docId = `${path}#document`;
  const nodes: NodeV1[] = [{ id: docId, name: path, kind: "document", path, span: span(1, Math.max(1, lines.length)), signature: null, exported: true, origin: "markdown", body_hash: contentHash(source), body_text: source.replace(/\s+/g, " "), summary_state: "pending", summary: null, crux: null, chars: source.length }];
  const refs: MarkdownRef[] = [];
  // Lightweight, explicit metadata hooks. `links`/`related` name document
  // targets; `references` names code symbols or paths. Unknown shapes are
  // ignored rather than promoted into guessed edges.
  try {
    const fm = matter(source).data as Record<string, unknown>;
    for (const key of ["links", "related"]) {
      const values = Array.isArray(fm[key]) ? fm[key] : typeof fm[key] === "string" ? [fm[key]] : [];
      for (const target of values) if (typeof target === "string") refs.push({ source: docId, target, kind: "link" });
    }
    const values = Array.isArray(fm.references) ? fm.references : typeof fm.references === "string" ? [fm.references] : [];
    for (const target of values) if (typeof target === "string") refs.push({ source: docId, target, kind: "code" });
  } catch { /* malformed frontmatter is ordinary document text */ }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    let end = lines.length;
    for (let j = i + 1; j < headings.length; j++) if (headings[j].level <= h.level) { end = headings[j].line - 1; break; }
    const body = lines.slice(h.line - 1, end).join("\n");
    const id = `${path}#${h.anchor}`;
    nodes.push({ id, name: h.title, kind: "section", path, span: span(h.line, end), signature: null, exported: true, origin: "markdown", body_hash: contentHash(body), body_text: body.replace(/\s+/g, " "), summary_state: "pending", summary: null, crux: null });
    refs.push({ source: i === 0 ? docId : `${path}#${headings.slice(0, i).filter((x) => x.level < h.level).at(-1)?.anchor ?? "document"}`, target: id, kind: "contains" });
    for (const m of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)|\[([^\]]+)\]:\s*(\S+)/g)) {
      const target = m[1] ?? m[3]; if (target) refs.push({ source: id, target, kind: "link" });
    }
    for (const m of body.matchAll(/`([^`\n]+)`/g)) refs.push({ source: id, target: m[1].trim(), kind: "code" });
  }
  return { nodes, refs };
}

/** Resolve document links and uniquely named backticked code symbols. */
export function resolveMarkdownEdges(nodes: NodeV1[], refs: MarkdownRef[]): EdgeV1[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byPath = new Map<string, NodeV1[]>(); const byName = new Map<string, NodeV1[]>();
  for (const n of nodes) { (byPath.get(n.path) ?? byPath.set(n.path, []).get(n.path)!).push(n); (byName.get(n.name) ?? byName.set(n.name, []).get(n.name)!).push(n); }
  const out: EdgeV1[] = [];
  for (const r of refs) {
    if (!byId.has(r.source)) continue;
    if (r.kind === "contains") {
      if (byId.has(r.target)) out.push({ source: r.source, target: r.target, relation: "contains", confidence: "extracted" });
      continue;
    }
    if (r.kind === "code") {
      const codePath = r.target.replace(/:L\d+(?:-L?\d+)?$/, "");
      const direct = byId.get(r.target) ?? byPath.get(codePath)?.find((n) => n.kind === "file" || n.kind === "document");
      const named = byName.get(r.target) ?? [];
      const target = direct ?? (named.length === 1 ? named[0] : undefined);
      if (target && target.id !== r.source) out.push({ source: r.source, target: target.id, relation: "references", confidence: "inferred" });
      continue;
    }
    if (/^(?:https?:|mailto:|#?$)/i.test(r.target)) continue;
    const [rawPath, rawAnchor] = r.target.split("#", 2);
    const sourcePath = byId.get(r.source)!.path;
    const targetPath = rawPath ? posix.normalize(posix.join(posix.dirname(sourcePath), rawPath)).replace(/^\.\//, "") : sourcePath;
    const target = rawAnchor ? byId.get(`${targetPath}#${slug(rawAnchor)}`) : (byId.get(`${targetPath}#document`) ?? byPath.get(targetPath)?.find((n) => n.kind === "file"));
    if (target && target.id !== r.source) out.push({ source: r.source, target: target.id, relation: "links_to", confidence: "extracted" });
  }
  return [...new Map(out.map((e) => [`${e.source}\0${e.relation}\0${e.target}`, e])).values()];
}
