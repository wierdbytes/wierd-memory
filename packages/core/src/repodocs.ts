/**
 * What a project already documents: its Markdown files with their headings.
 *
 * The curator gets this list (not the contents) so that it knows the
 * repository answers a question before it turns the answer into a note — a
 * dream that saw a session read README.md would otherwise propose README.md
 * back as memory. Paths and headings are enough to tell; contents would cost
 * tokens in every pass.
 */

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_FILES } from "./agentsmd.ts";

/** Folders of documentation, read recursively (a few levels). */
const DOC_DIRS = ["docs", "doc", "documentation", "wiki", ".github"];
/** Folders whose sub-folders are packages of a monorepo: their README is the package's documentation. */
const PACKAGE_DIRS = ["packages", "apps", "crates", "libs", "modules", "services", "plugins", "extensions"];
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", ".next", "coverage"]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_HEADINGS = 24;

export interface RepoDocsOptions {
	/** Total size of the rendered list, in characters. */
	maxChars?: number;
	/** Paths (relative) to leave out — the context file, which the curator gets whole. */
	exclude?: string[];
}

const isMd = (name: string) => /\.(md|mdx|markdown)$/i.test(name);

function entries(dir: string): Dirent[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

/** Markdown files under `rel` (relative to `root`), depth-first, at most `depth` folders down. */
function walk(root: string, rel: string, depth: number, out: string[]): void {
	for (const e of entries(join(root, rel))) {
		if (e.name.startsWith(".")) continue;
		const path = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) {
			if (depth > 0 && !SKIP.has(e.name)) walk(root, path, depth - 1, out);
		} else if (e.isFile() && isMd(e.name)) out.push(path);
	}
}

/** `#`–`###` headings outside code fences. */
export function markdownHeadings(text: string, max = MAX_HEADINGS): string[] {
	const out: string[] = [];
	let fence = false;
	for (const line of text.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) fence = !fence;
		if (fence) continue;
		const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
		if (!m) continue;
		const h = m[2].replace(/`/g, "").trim();
		if (!h) continue;
		out.push(`${"#".repeat(m[1].length)} ${h.length > 80 ? `${h.slice(0, 79)}…` : h}`);
		if (out.length >= max) break;
	}
	return out;
}

/**
 * The project's documentation as lines `path: # Title · ## Section · …`: root
 * Markdown files, documentation folders, READMEs of top-level folders and of
 * monorepo packages. Capped at `maxChars`; what does not fit is counted.
 */
export function listRepoDocs(root: string, opts: RepoDocsOptions = {}): string[] {
	const maxChars = opts.maxChars ?? 4000;
	if (!root || !existsSync(root)) return [];
	const skip = new Set([...CONTEXT_FILES, ...(opts.exclude ?? [])]);
	const files: string[] = [];
	const top = entries(root);
	// README first: it is what a session reads first.
	for (const e of top) if (e.isFile() && isMd(e.name)) files.push(e.name);
	files.sort((a, b) => Number(!/^readme\./i.test(a)) - Number(!/^readme\./i.test(b)));
	for (const d of DOC_DIRS) if (top.some((e) => e.isDirectory() && e.name === d)) walk(root, d, 3, files);
	for (const e of top) {
		if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name) || DOC_DIRS.includes(e.name)) continue;
		const subs = PACKAGE_DIRS.includes(e.name) ? entries(join(root, e.name)).filter((x) => x.isDirectory()).map((x) => `${e.name}/${x.name}`) : [e.name];
		for (const dir of subs) for (const f of entries(join(root, dir))) if (f.isFile() && /^readme\.(md|mdx|markdown)$/i.test(f.name)) files.push(`${dir}/${f.name}`);
	}
	const out: string[] = [];
	let used = 0;
	let left = 0;
	for (const rel of [...new Set(files)]) {
		if (skip.has(rel)) continue;
		if (left) {
			left++;
			continue;
		}
		let line = rel;
		// A changelog's headings are versions: its path says enough.
		if (!/^changelog/i.test(rel.split("/").pop() ?? "")) {
			try {
				const path = join(root, rel);
				if (statSync(path).size <= MAX_FILE_BYTES) {
					const hs = markdownHeadings(readFileSync(path, "utf-8"));
					if (hs.length) line = `${rel}: ${hs.join(" · ")}`;
				}
			} catch {
				// unreadable: the path alone
			}
		}
		if (used + line.length > maxChars) {
			// Keep at least the path when the headings do not fit.
			if (used + rel.length <= maxChars) {
				out.push(rel);
				used += rel.length + 1;
			} else left = 1;
			continue;
		}
		out.push(line);
		used += line.length + 1;
	}
	if (left) out.push(`… and ${left} more Markdown file(s)`);
	return out;
}
