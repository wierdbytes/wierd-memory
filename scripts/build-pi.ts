/**
 * Builds the npm package @wierdbytes/pi-memory into packages/pi/dist:
 *
 *   index.js       the extension, bundled: @wierd-memory/core is inlined (it is not published on its own),
 *                  the packages pi provides to extensions stay imports (pi maps them to its own copies)
 *   package.json   the published manifest, made from packages/pi/package.json (version, peers)
 *   README.md CHANGELOG.md LICENSE
 *
 * The dream runner (runner.ts) is not in it: the server starts it from its own checkout.
 *
 *   bun run build:pi && npm pack --dry-run packages/pi/dist
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PKG = join(ROOT, "packages", "pi");
const OUT = join(PKG, "dist");
const REPO = "wierdbytes/wierd-memory";

/** Provided by pi at runtime: never bundled, declared as peers with "*". */
const HOST = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];

const dev = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")) as { version: string; keywords: string[]; peerDependencies: Record<string, string> };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const built = await Bun.build({
	entrypoints: [join(PKG, "index.ts")],
	outdir: OUT,
	naming: "index.js",
	target: "node",
	format: "esm",
	external: HOST.flatMap((p) => [p, `${p}/*`]),
});
if (!built.success) {
	for (const m of built.logs) console.error(m);
	process.exit(1);
}

const js = readFileSync(join(OUT, "index.js"), "utf-8");
const imports = [...js.matchAll(/\bfrom\s*"([^"]+)"|\bimport\s*\(?\s*"([^"]+)"|\brequire\(\s*"([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? m[3]);
const foreign = imports.filter((s) => !s.startsWith("node:") && !HOST.some((h) => s === h || s.startsWith(`${h}/`)));
if (foreign.length || js.includes("@wierd-memory/")) {
	console.error(`dist/index.js must import only node: builtins and host packages, found: ${foreign.join(", ") || "@wierd-memory/…"}`);
	process.exit(1);
}

const manifest = {
	name: "@wierdbytes/pi-memory",
	version: dev.version,
	description:
		"Long-term memory for pi: injects the approved wierd-memory index into every session and adds memory_search / memory_read / memory_inbox tools and /memory, /dream, /remember commands. Needs the wierd-memory server.",
	type: "module",
	files: ["index.js", "README.md", "CHANGELOG.md", "LICENSE"],
	keywords: dev.keywords,
	license: "MIT",
	author: "wierdbytes",
	homepage: `https://github.com/${REPO}/tree/main/packages/pi`,
	repository: { type: "git", url: `git+https://github.com/${REPO}.git`, directory: "packages/pi" },
	bugs: { url: `https://github.com/${REPO}/issues` },
	publishConfig: { access: "public" },
	pi: { extensions: ["./index.js"] },
	peerDependencies: Object.fromEntries(Object.keys(dev.peerDependencies).map((p) => [p, "*"])),
};
for (const p of Object.keys(manifest.peerDependencies)) if (!HOST.includes(p)) throw new Error(`peer ${p} is not provided by pi: bundle it instead`);
writeFileSync(join(OUT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

copyFileSync(join(PKG, "README.md"), join(OUT, "README.md"));
copyFileSync(join(PKG, "CHANGELOG.md"), join(OUT, "CHANGELOG.md"));
copyFileSync(join(ROOT, "LICENSE"), join(OUT, "LICENSE"));

console.log(`built ${manifest.name}@${manifest.version} → ${OUT} (index.js ${(js.length / 1024).toFixed(0)} KB; imports: ${[...new Set(imports)].join(", ")})`);
