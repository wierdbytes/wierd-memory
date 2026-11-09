/**
 * Note text as Markdown. The text is written by a model from session
 * transcripts, so it is not trusted: raw HTML in it is shown as text, and the
 * rendered HTML is then rebuilt from an allow-list of tags and attributes.
 */

import { Marked } from "marked";
import { memo, useMemo } from "react";
import { cls } from "../util.ts";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const marked = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		// Raw HTML (block or inline) is printed, never interpreted.
		html(token) {
			return escapeHtml(token.text);
		},
		// No remote images: show what it is instead of fetching it.
		image(token) {
			return `<span class="md-image">[image: ${escapeHtml(token.text || token.href)}]</span>`;
		},
	},
});

const TAGS = new Set(["P", "BR", "HR", "STRONG", "EM", "DEL", "CODE", "PRE", "BLOCKQUOTE", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "A", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "SPAN", "INPUT"]);
const SAFE_URL = /^(https?:|mailto:|#)/i;

function clean(node: Node, doc: Document): Node | null {
	if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent ?? "");
	if (!(node instanceof Element)) return null;
	const kids = () => {
		const frag = doc.createDocumentFragment();
		for (const child of Array.from(node.childNodes)) {
			const c = clean(child, doc);
			if (c) frag.appendChild(c);
		}
		return frag;
	};
	const tag = node.tagName.toUpperCase();
	if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE"].includes(tag)) return null;
	if (!TAGS.has(tag)) return kids();
	const el = doc.createElement(tag.toLowerCase());
	if (tag === "A") {
		const url = node.getAttribute("href") ?? "";
		if (SAFE_URL.test(url)) {
			el.setAttribute("href", url);
			el.setAttribute("target", "_blank");
			el.setAttribute("rel", "noopener noreferrer");
		}
	} else if (tag === "INPUT") {
		// GFM task list boxes only.
		if (node.getAttribute("type") !== "checkbox") return null;
		el.setAttribute("type", "checkbox");
		el.setAttribute("disabled", "");
		if (node.hasAttribute("checked")) el.setAttribute("checked", "");
	} else if (tag === "CODE" || tag === "SPAN") {
		const c = node.getAttribute("class") ?? "";
		if (/^(language-[\w+-]+|md-image)$/.test(c)) el.setAttribute("class", c);
	} else if (tag === "OL") {
		const start = node.getAttribute("start");
		if (start && /^\d+$/.test(start)) el.setAttribute("start", start);
	} else if (tag === "TH" || tag === "TD") {
		const align = node.getAttribute("align");
		if (align && /^(left|right|center)$/.test(align)) el.setAttribute("align", align);
	}
	el.appendChild(kids());
	return el;
}

export function renderMarkdown(text: string): string {
	const raw = marked.parse(text, { async: false });
	const doc = new DOMParser().parseFromString(`<body>${raw}</body>`, "text/html");
	const out = doc.createElement("div");
	for (const child of Array.from(doc.body.childNodes)) {
		const c = clean(child, doc);
		if (c) out.appendChild(c);
	}
	return out.innerHTML;
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
	const html = useMemo(() => renderMarkdown(text), [text]);
	if (!text.trim()) return <div className={cls("md md-empty", className)}>no text</div>;
	// biome-ignore lint/security/noDangerouslySetInnerHtml: rebuilt from an allow-list above
	return <div className={cls("md", className)} dangerouslySetInnerHTML={{ __html: html }} />;
});

/** A title: plain text, with `code spans` set in monospace (nothing else is interpreted). */
export function TitleText({ text }: { text: string }) {
	const parts = text.split(/(`[^`\n]+`)/g);
	return (
		<>
			{parts.map((p, i) =>
				p.length > 2 && p.startsWith("`") && p.endsWith("`") ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: static split
					<code key={i}>{p.slice(1, -1)}</code>
				) : (
					p
				),
			)}
		</>
	);
}
