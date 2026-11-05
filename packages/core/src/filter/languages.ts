/**
 * Languages the settings picker offers, each by its own name ("Türkçe", not "Turkish"), as a
 * speaker of it would look for it. A stored English name or a lower-case one becomes the native
 * name, so "Turkish", "turkce" and "Türkçe" are one setting. A language not listed is kept as
 * typed.
 */
const LANGUAGE_ALIASES: Record<string, string[]> = {
	English: ["english"],
	Türkçe: ["turkish", "turkce"],
	Deutsch: ["german"],
	Français: ["french", "francais"],
	Español: ["spanish", "espanol", "castellano"],
	Português: ["portuguese", "portugues"],
	Italiano: ["italian"],
	Nederlands: ["dutch", "flemish"],
	Polski: ["polish"],
	Čeština: ["czech", "cestina"],
	Svenska: ["swedish"],
	Norsk: ["norwegian"],
	Dansk: ["danish"],
	Suomi: ["finnish"],
	Română: ["romanian", "romana"],
	Magyar: ["hungarian"],
	Ελληνικά: ["greek"],
	Русский: ["russian"],
	Українська: ["ukrainian"],
	العربية: ["arabic"],
	עברית: ["hebrew"],
	فارسی: ["persian", "farsi"],
	हिन्दी: ["hindi"],
	中文: ["chinese", "mandarin"],
	日本語: ["japanese"],
	한국어: ["korean"],
	"Tiếng Việt": ["vietnamese"],
	"Bahasa Indonesia": ["indonesian"],
	ไทย: ["thai"],
	Català: ["catalan"],
};

export const LANGUAGES = Object.keys(LANGUAGE_ALIASES);

const BY_ALIAS = new Map<string, string>(
	Object.entries(LANGUAGE_ALIASES).flatMap(([name, aliases]) => [
		[name.toLocaleLowerCase(), name],
		...aliases.map((a) => [a, name] as [string, string]),
	]),
);

/** The picker's name for a language: "turkish" and "Türkçe" both become "Türkçe". */
export function canonicalLanguages(names: readonly string[]): string[] {
	const out = names
		.map((n) => n.trim())
		.filter(Boolean)
		.map((n) => BY_ALIAS.get(n.toLocaleLowerCase()) ?? n);
	return [...new Set(out)];
}
