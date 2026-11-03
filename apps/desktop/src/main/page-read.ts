/**
 * The fixed read a site tab runs in its isolated world (never script from elsewhere): the page's
 * HTML, its title, and the text it shows for the readers' check and sign-in markers. The text is
 * what the browser renders: an element `checkVisibility()` says is not shown (hidden,
 * display:none, visibility:hidden) is left out with everything it holds, and so are elements
 * matching `exclude` (the posting's own words). The page is read, never changed.
 *
 * Kept apart from site-browser.ts (which needs Electron) so the script itself is unit-tested.
 */
export function snapshotScript(exclude: string): string {
	return String.raw`(() => {
	const exclude = ${JSON.stringify(exclude)};
	const parts = [];
	const skip = (el) => {
		try { if (exclude && el.matches(exclude)) return true; } catch {}
		return typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true });
	};
	const walk = (el) => {
		if (skip(el)) return;
		for (const node of el.childNodes) {
			if (node.nodeType === 3) parts.push(node.nodeValue);
			else if (node.nodeType === 1) walk(node);
		}
	};
	try { if (document.body) walk(document.body); } catch {}
	return {
		html: (document.doctype ? new XMLSerializer().serializeToString(document.doctype) : "") + document.documentElement.outerHTML,
		title: document.title,
		text: parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 200000),
	};
})()`;
}
