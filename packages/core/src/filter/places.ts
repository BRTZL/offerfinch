import { COUNTRIES } from "./countries";

/**
 * Small gazetteer for classifying job locations. A location entry it does not recognize is a
 * reject (only jobs that clearly hire from the user's country are kept), so the user's own
 * country needs its towns and districts here, not just its big cities.
 */

const COUNTRY_ALIASES: Record<string, string[]> = {
	Türkiye: [
		"turkey",
		"türkiye",
		"turkiye",
		"istanbul", // public-ok: a city in the gazetteer, not anyone's address
		"i̇stanbul",
		"izmir",
		"i̇zmir",
		"ankara",
		"antalya",
		"bursa",
		"kocaeli",
		"eskisehir",
		"eskişehir",
		"konya",
		"adana",
		"gaziantep",
		"kayseri",
		"mersin",
		"trabzon",
		"samsun",
		"denizli",
		"sakarya",
		"tekirdag",
		"tekirdağ",
		"gebze",
		// Istanbul districts, as job boards write them.
		"kadikoy",
		"kadıköy",
		"besiktas",
		"beşiktaş",
		"sisli",
		"şişli",
		"uskudar",
		"üsküdar",
		"atasehir",
		"ataşehir",
		"maslak",
		"sariyer",
		"sarıyer",
		"pendik",
		"kartal",
		"tuzla",
		"umraniye",
		"ümraniye",
		"beyoglu",
		"beyoğlu",
		"bakirkoy",
		"bakırköy",
		"esenyurt",
		"beylikduzu",
		"beylikdüzü",
		"maltepe",
		"kagithane",
		"kağıthane",
		"basaksehir",
		"başakşehir",
		// Ankara and Izmir districts.
		"cankaya",
		"çankaya",
		"yenimahalle",
		"etimesgut",
		"bornova",
		"karsiyaka",
		"karşıyaka",
	],
	"United States": [
		"united states",
		"usa",
		"u.s.",
		"us",
		"u.s.a.",
		"san francisco",
		"new york",
		"nyc",
		"seattle",
		"austin",
		"boston",
		"chicago",
		"denver",
		"los angeles",
		"atlanta",
		"charlotte",
		"washington",
		"miami",
		"palo alto",
		"mountain view",
		"sunnyvale",
		"san jose",
		"san diego",
		"portland",
		"dallas",
		"houston",
		"philadelphia",
		"salt lake city",
		"detroit",
		"phoenix",
		"minneapolis",
		"pittsburgh",
		"raleigh",
		"nashville",
		"columbus",
		"indianapolis",
		"san mateo",
		"redwood city",
		"menlo park",
		"boulder",
		"new jersey",
		"new york city",
		"brooklyn",
		"oakland",
		"irvine",
		"remote us",
		"remote - us",
		"us remote",
		"us-remote",
		"california",
		"texas",
		"colorado",
		// The other states, by name. Georgia is left out: it is also a country.
		"alabama",
		"alaska",
		"arizona",
		"arkansas",
		"connecticut",
		"delaware",
		"florida",
		"hawaii",
		"idaho",
		"illinois",
		"indiana",
		"iowa",
		"kansas",
		"kentucky",
		"louisiana",
		"maine",
		"maryland",
		"massachusetts",
		"michigan",
		"minnesota",
		"mississippi",
		"missouri",
		"montana",
		"nebraska",
		"nevada",
		"new hampshire",
		"new mexico",
		"north carolina",
		"north dakota",
		"ohio",
		"oklahoma",
		"oregon",
		"pennsylvania",
		"rhode island",
		"south carolina",
		"south dakota",
		"tennessee",
		"utah",
		"vermont",
		"virginia",
		"west virginia",
		"wisconsin",
		"wyoming",
		"district of columbia",
		"fort worth",
		"san antonio",
		"orlando",
		"tampa",
		"baltimore",
		"st. louis",
		"kansas city",
		"las vegas",
		"sacramento",
		"cincinnati",
		"cleveland",
		"milwaukee",
		"huntsville",
		"reston",
		"herndon",
		"bethesda",
		"arlington",
	],
	"United Kingdom": [
		"united kingdom",
		"uk",
		"u.k.",
		"england",
		"london",
		"manchester",
		"edinburgh",
		"glasgow",
		"bristol",
		"cambridge",
		"oxford",
		"great britain",
	],
	Canada: [
		"canada",
		"toronto",
		"vancouver",
		"montreal",
		"ottawa",
		"calgary",
		"waterloo",
	],
	Germany: [
		"germany",
		"deutschland",
		"berlin",
		"munich",
		"münchen",
		"hamburg",
		"frankfurt",
		"cologne",
		"köln",
		"stuttgart",
	],
	Netherlands: [
		"netherlands",
		"amsterdam",
		"rotterdam",
		"utrecht",
		"the hague",
		"eindhoven",
	],
	Spain: [
		"spain",
		"españa",
		"barcelona",
		"madrid",
		"valencia",
		"malaga",
		"málaga",
		"seville",
	],
	France: ["france", "paris", "lyon", "toulouse", "nice"],
	Ireland: ["ireland", "dublin", "cork"],
	Portugal: ["portugal", "lisbon", "lisboa", "porto"],
	Poland: [
		"poland",
		"warsaw",
		"kraków",
		"krakow",
		"wroclaw",
		"wrocław",
		"gdansk",
	],
	Italy: ["italy", "milan", "milano", "rome", "roma", "turin"],
	Switzerland: ["switzerland", "zurich", "zürich", "geneva", "lausanne"],
	Sweden: ["sweden", "stockholm", "gothenburg", "malmö", "malmo"],
	Denmark: ["denmark", "copenhagen"],
	Norway: ["norway", "oslo"],
	Finland: ["finland", "helsinki"],
	Belgium: ["belgium", "brussels"],
	Austria: ["austria", "vienna"],
	"Czech Republic": ["czech republic", "czechia", "prague", "brno"],
	Romania: ["romania", "bucharest", "cluj"],
	Serbia: ["serbia", "belgrade"],
	Azerbaijan: ["azerbaijan", "baku"],
	Greece: ["greece", "athens"],
	Estonia: ["estonia", "tallinn"],
	Lithuania: ["lithuania", "vilnius"],
	Ukraine: ["ukraine", "kyiv", "kiev"],
	Israel: ["israel", "tel aviv", "jerusalem"],
	"United Arab Emirates": ["united arab emirates", "uae", "dubai", "abu dhabi"],
	"Saudi Arabia": ["saudi arabia", "riyadh"],
	India: [
		"india",
		"bangalore",
		"bengaluru",
		"hyderabad",
		"pune",
		"mumbai",
		"delhi",
		"gurgaon",
		"gurugram",
		"chennai",
		"noida",
	],
	Singapore: ["singapore"],
	Japan: ["japan", "tokyo", "osaka"],
	"South Korea": ["south korea", "korea", "seoul"],
	China: ["china", "shanghai", "beijing", "shenzhen"],
	"Hong Kong": ["hong kong"],
	Australia: ["australia", "sydney", "melbourne", "brisbane"],
	"New Zealand": ["new zealand", "auckland"],
	Brazil: ["brazil", "brasil", "são paulo", "sao paulo", "rio de janeiro"],
	Mexico: ["mexico", "méxico", "mexico city", "guadalajara"],
	Argentina: ["argentina", "buenos aires"],
	Colombia: ["colombia", "bogota", "bogotá", "medellin"],
	Chile: ["chile", "santiago"],
	Philippines: ["philippines", "manila"],
	Vietnam: ["vietnam", "ho chi minh", "hanoi"],
	Indonesia: ["indonesia", "jakarta"],
	"South Africa": ["south africa", "cape town", "johannesburg"],
	Egypt: ["egypt", "cairo"],
	Nigeria: ["nigeria", "lagos"],
	Kenya: ["kenya", "nairobi"],
};

/**
 * Two-letter US state codes after a comma ("Owego, NY", "Arlington, VA 22202"). Only read in a
 * job's location fields, never in prose.
 */
const US_STATE_CODES =
	/,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b(?!\.)/;
/** State codes that are also a country's ISO code: "Berlin, DE" is Germany, not Delaware. */
const STATE_CODE_COUNTRY: Record<string, string> = {
	AL: "Albania",
	AR: "Argentina",
	AZ: "Azerbaijan",
	CA: "Canada",
	CO: "Colombia",
	DE: "Germany",
	GA: "Gabon",
	ID: "Indonesia",
	IL: "Israel",
	IN: "India",
	LA: "Laos",
	MA: "Morocco",
	MD: "Moldova",
	ME: "Montenegro",
	MN: "Mongolia",
	MT: "Malta",
	NE: "Niger",
	PA: "Panama",
	SC: "Seychelles",
	SD: "Sudan",
	TN: "Tunisia",
	VA: "Vatican City",
};
const CANADA_PROVINCE_CODES = /,\s*(ON|BC|QC|AB|MB|NS|NB|NL|PE|SK)\b(?!\.)/;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasPattern(alias: string, flags = "iu"): RegExp {
	return new RegExp(
		`(?:^|[^\\p{L}])${escapeRegExp(alias)}(?:$|[^\\p{L}])`,
		flags,
	);
}

/**
 * Every alias, longest first, so "Papua New Guinea" is read before "Guinea" and "New Mexico"
 * before "Mexico". Every country the settings offer (`COUNTRIES`) is an alias of itself.
 */
const ALIASES: [country: string, alias: string][] = [
	...Object.entries(COUNTRY_ALIASES).flatMap(([country, aliases]) =>
		aliases.map((alias) => [country, alias] as [string, string]),
	),
	...COUNTRIES.filter(
		(name) => !COUNTRY_ALIASES[name]?.includes(name.toLowerCase()),
	).map((name) => [name, name.toLowerCase()] as [string, string]),
].sort((a, b) => b[1].length - a[1].length);

/** Short aliases such as US, UK and UAE only count in uppercase, so "us" in prose does not match. */
const ALIAS_INDEX = ALIASES.map(([country, alias]) =>
	alias.length <= 3 && !alias.includes(".")
		? { country, pattern: aliasPattern(alias.toUpperCase(), "gu") }
		: { country, pattern: aliasPattern(alias, "giu") },
);

/** Turkish dotted and dotless i read as plain i: "İzmir" is "Izmir". */
function foldTurkish(text: string): string {
	return text
		.replace(/İ/g, "I")
		.replace(/ı/g, "i")
		.replace(/\u0307/g, "");
}

/** Countries mentioned in a location string or sentence. */
export function countriesIn(text: string): string[] {
	const found = new Set<string>();
	// Each match is blanked out, so a longer name ("New Mexico") hides the shorter one inside it.
	let rest = foldTurkish(text)
		.replace(/\b([A-Z])\.(?=[A-Z]\.?)/g, "$1")
		.replace(/\b(US|UK)\./g, "$1");
	for (const { country, pattern } of ALIAS_INDEX) {
		pattern.lastIndex = 0;
		if (!pattern.test(rest)) continue;
		found.add(country);
		pattern.lastIndex = 0;
		rest = rest.replace(pattern, (m) => " ".repeat(m.length));
	}
	// "Atlanta, Georgia" is the US state.
	if (found.has("United States")) found.delete("Georgia");
	return [...found];
}

/**
 * Countries of one of a job's location fields: `countriesIn`, plus US state and Canadian province
 * codes after a comma ("Owego, NY"), which are read only here, never in prose.
 */
export function countriesInLocation(location: string): string[] {
	const found = new Set(countriesIn(location));
	const state = location.match(US_STATE_CODES)?.[1];
	if (state) {
		const sameCode = STATE_CODE_COUNTRY[state];
		if (!sameCode || !found.has(sameCode)) found.add("United States");
	}
	if (found.size === 0 && CANADA_PROVINCE_CODES.test(location))
		found.add("Canada");
	return [...found];
}
