/**
 * Fixture checks for summary scope selection (mirrors buildSummaryScopes rules).
 * Run: node scripts/test-summary-scopes.mjs
 *
 * Keep behavioral expectations in sync with src/lib/localSummarizer.ts.
 */

const SECTION_HEADER_RE =
	/^(?:эпизод|часть|глава|раздел|episode|part|chapter|section)\s*\d+\b/iu;

function isSectionHeaderLine(line) {
	const t = line.trim();
	if (!t) return false;
	if (SECTION_HEADER_RE.test(t)) return true;
	return /^(?:эпизод|часть|глава|episode|part|chapter)\s*\d+\s*[:.\-–—]/iu.test(t);
}

function splitIntoSentences(text) {
	const unified = text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
	if (!unified) return [];
	const punctuationHits = (unified.match(/[.!?…]/g) ?? []).length;
	const sentences = [];
	if (punctuationHits >= 2) {
		const rawParts = unified.split(/([.!?…]+)/u);
		for (let i = 0; i < rawParts.length; i += 2) {
			const core = (rawParts[i] ?? "").trim();
			const punct = (rawParts[i + 1] ?? "").trim();
			const sentence = `${core}${punct}`.trim();
			if (sentence.length >= 15) sentences.push(sentence);
		}
	} else {
		const words = unified.split(/\s+/);
		let buf = [];
		let len = 0;
		for (const word of words) {
			buf.push(word);
			len += word.length + 1;
			if (len >= 140) {
				const piece = buf.join(" ").trim();
				if (piece.length >= 15) sentences.push(piece);
				buf = [];
				len = 0;
			}
		}
		if (buf.length) {
			const piece = buf.join(" ").trim();
			if (piece.length >= 15) sentences.push(piece);
		}
	}
	return sentences;
}

function mergeLinesToText(text) {
	const lines = text
		.replace(/\r\n/g, "\n")
		.split(/\n+/)
		.map((l) => l.replace(/^[-*•]\s*/, "").trim())
		.filter(Boolean);
	const headers = [];
	let title = "";
	let bodyParts = [];
	const flush = () => {
		const body = bodyParts.join(" ").replace(/\s+/g, " ").trim();
		if (title || body) headers.push({ title, body });
		title = "";
		bodyParts = [];
	};
	for (const line of lines) {
		if (isSectionHeaderLine(line)) {
			flush();
			title = line.trim();
			continue;
		}
		bodyParts.push(line);
	}
	flush();
	return { headers };
}

function buildSummaryScopes(text, options = {}) {
	const fullOutline = options.fullOutline === true;
	const firstMaxChars = options.firstSegmentMaxChars ?? 6000;
	const firstMaxUnits = options.firstSegmentMaxUnits ?? 80;
	const maxNamed = options.maxNamedScopes ?? 8;

	const { headers } = mergeLinesToText(text);
	const named = headers.filter((h) => h.title && h.body);
	if (named.length >= 1) {
		const sections = named.map((h) => ({
			title: h.title,
			units: splitIntoSentences(h.body),
		}));
		const withUnits = sections.filter((s) => s.units.length > 0);
		const chosen =
			withUnits.length <= maxNamed
				? withUnits
				: [
						withUnits[0],
						...Array.from({ length: maxNamed - 1 }, (_, i) => {
							const rest = withUnits.slice(1);
							const idx = Math.round(
								(i * (rest.length - 1)) / Math.max(maxNamed - 2, 1),
							);
							return rest[idx];
						}),
					].filter(Boolean);
		const unique = [];
		for (const s of chosen) {
			if (!unique.includes(s)) unique.push(s);
		}
		return unique.map((s) => ({ title: s.title, units: s.units }));
	}

	const allUnits = splitIntoSentences(text.replace(/\n+/g, " "));
	if (!fullOutline) {
		const first = [];
		let chars = 0;
		for (const u of allUnits) {
			if (first.length >= firstMaxUnits) break;
			if (chars > 0 && chars + u.length > firstMaxChars) break;
			first.push(u);
			chars += u.length + 1;
		}
		return [{ title: "", units: first }];
	}
	// fullOutline: short → one scope with all units; long → even windows incl. last
	const MAP_CHUNK = 50;
	const MAX_WIN = 8;
	if (allUnits.length <= MAP_CHUNK * 2) {
		return [{ title: "", units: allUnits }];
	}
	const windows = [];
	for (let i = 0; i < allUnits.length; i += MAP_CHUNK) {
		windows.push(allUnits.slice(i, i + MAP_CHUNK));
	}
	const indexes = new Set([0, windows.length - 1]);
	for (let i = 1; i < MAX_WIN - 1; i += 1) {
		indexes.add(Math.round((i * (windows.length - 1)) / (MAX_WIN - 1)));
	}
	const unique = [...indexes].sort((a, b) => a - b);
	return unique.map((wi, display) => ({
		title: unique.length >= 2 ? `Part ${display + 1}/${unique.length}` : "",
		units: windows[wi] ?? [],
	}));
}

function assert(cond, msg) {
	if (!cond) {
		console.error("FAIL:", msg);
		process.exitCode = 1;
		return false;
	}
	console.log("OK:", msg);
	return true;
}

// 1) Episode 1 intro must not pull later centuries when headers exist
const episodeSample = `
Эпизод 1: вступление
Привет, меня зовут Влад. Сегодня мы повторим историю для ЕГЭ. Сначала киевские князья и план курса.
Эпизод 2: смута
В начале семнадцатого века Россия переживала Смутное время. Лжедмитрий и боярские интриги.
Эпизод 3: петр
Петр Первый проводил реформы и строил флот. Окно в Европу.
`.trim();

const epScopes = buildSummaryScopes(episodeSample);
assert(epScopes.length >= 1, "episode scopes non-empty");
assert(
	/эпизод\s*1/i.test(epScopes[0].title),
	`first scope is Episode 1, got: ${epScopes[0].title}`,
);
const ep1Text = epScopes[0].units.join(" ").toLocaleLowerCase();
assert(
	ep1Text.includes("влад") || ep1Text.includes("егэ") || ep1Text.includes("киевск"),
	"episode 1 units talk about intro",
);
assert(
	!ep1Text.includes("лжедмитрий") && !ep1Text.includes("петр"),
	"episode 1 units must not include later episode bodies",
);

// 2) No headers + long mush: default keeps only the start (first segment)
const filler = "Это предложение про начало лекции и план тем истории. ";
const late = "Смутное время семнадцатый век и Лжедмитрий захватили власть. ";
const longNoHeaders = (filler.repeat(80) + late.repeat(80)).trim();
const startScopes = buildSummaryScopes(longNoHeaders, {
	firstSegmentMaxChars: 600,
	firstSegmentMaxUnits: 6,
});
assert(startScopes.length === 1, "no-header default is single scope");
const startText = startScopes[0].units.join(" ");
assert(
	startText.length <= 900,
	`first segment capped, got ${startText.length} chars`,
);
// With tight cap, late mush should be cut if it appears only at the end
const allLateAtEnd = filler.repeat(20) + "\n\n" + late.repeat(30);
const scoped = buildSummaryScopes(allLateAtEnd, {
	firstSegmentMaxChars: 400,
	firstSegmentMaxUnits: 5,
});
const scopedJoined = scoped[0].units.join(" ").toLocaleLowerCase();
assert(
	!scopedJoined.includes("лжедмитрий"),
	"first-segment cap excludes late-era mush when it is only at the end",
);

// 3) fullOutline covers full transcript including late content
const full = buildSummaryScopes(longNoHeaders, { fullOutline: true });
assert(full.length >= 1, "fullOutline still returns scopes");
const fullJoined = full.map((s) => s.units.join(" ")).join(" ").toLocaleLowerCase();
assert(
	fullJoined.includes("лжедмитрий") || fullJoined.includes("смутное"),
	"fullOutline includes late transcript content",
);

// 4) fullOutline short lecture: one scope with early + late markers
const shortFull = (
	"как бы я начал урок издалека сейчас популярна первая тема курса. ".repeat(8) +
	"объясняют основные правила поведения похожие на то что обсуждали раньше. ".repeat(6) +
	"итог это краткий вывод по материалу и список того что важно запомнить. ".repeat(6)
).trim();
const shortScopes = buildSummaryScopes(shortFull, { fullOutline: true });
const shortAll = shortScopes.map((s) => s.units.join(" ")).join(" ").toLocaleLowerCase();
assert(
	shortAll.includes("первая тема") && shortAll.includes("итог"),
	"fullOutline short lecture keeps intro and closing thesis",
);

// 5) Even windows always include last index
function pickEvenWindowIndexes(windowCount, maxWindows) {
	if (windowCount <= 0) return [];
	if (windowCount <= maxWindows) {
		return Array.from({ length: windowCount }, (_, i) => i);
	}
	const indexes = new Set([0, windowCount - 1]);
	for (let i = 1; i < maxWindows - 1; i += 1) {
		indexes.add(Math.round((i * (windowCount - 1)) / (maxWindows - 1)));
	}
	return [...indexes].sort((a, b) => a - b);
}
const even = pickEvenWindowIndexes(20, 8);
assert(even[0] === 0 && even[even.length - 1] === 19, "even windows include first and last");

if (!process.exitCode) {
	console.log("\nAll summary-scope fixtures passed.");
}
