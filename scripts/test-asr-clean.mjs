/**
 * Fixture checks for YouTube ASR timecode cleaning + glue order.
 * Run: node scripts/test-asr-clean.mjs
 * Keep in sync with src/summarizer.ts scrubAllTimecodes / cleanYouTubeTranscriptText.
 */

function isPureTimestampLine(line) {
	return /^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?$/u.test(line.trim());
}

function scrubAllTimecodes(text) {
	let s = text.replace(/\u200b/g, "");
	if (!s.trim()) return "";
	if (isPureTimestampLine(s)) return "";

	for (let pass = 0; pass < 6; pass += 1) {
		const before = s;
		s = s.replace(/(?:(?:\d{1,2}:){1,2}\d{2,3}(?:\.\d+)?)/g, " ");
		s = s.replace(
			/(?:^|[\s])(?:минут[аы]?|мин\.?)\s*\d{1,3}\s*(?:секунд[аы]?|сек\.?)?/giu,
			" ",
		);
		s = s.replace(
			/(?:^|[\s])(?:час(?:а|ов)?|ч\.)\s*\d{0,3}\s*(?:минут[аы]?|мин\.?)?\s*\d{0,3}\s*(?:секунд[аы]?|сек\.?)?/giu,
			" ",
		);
		s = s.replace(
			/(?:^|[\s])\d{1,3}\s*(?:час(?:а|ов)?|минуты|минута|минут|секунды|секунда|секунд|мин\.?|сек\.?)(?=[\s.,!?]|$)/giu,
			" ",
		);
		s = s.replace(
			/(?:^|[\s])(?:минуты|минута|минут|секунды|секунда|секунд|мин\.?|сек\.?)\s*\d{1,3}(?=[\s.,!?]|$)/giu,
			" ",
		);
		s = s.replace(
			/(?:секунды|секунда|секунд|минуты|минута|минут|сек\.?|мин\.?)(?=\p{L})/giu,
			" ",
		);
		s = s.replace(
			/(?:^|[\s])(?:секунды|секунда|секунд|сек\.?)(?:\s*\d{0,3})?(?=[\s.,!?]|$)/giu,
			" ",
		);
		s = s.replace(/^\d{1,4}(?=\p{L})/u, "");
		s = s.replace(/(?:^|[\s])\d{1,3}(?=[\s.,!?]|$)/g, " ");
		s = s.replace(/^[:\-–—•.,;\s]+/u, "");
		s = s.replace(/\s+/g, " ").trim();
		if (s === before) break;
	}
	return s;
}

function cleanASRTimecodesLine(line) {
	return scrubAllTimecodes(line);
}

const SECTION_HEADER_RE =
	/^(?:эпизод|часть|глава|раздел|episode|part|chapter|section)\s*\d+\b/iu;

function isTranscriptSectionHeader(line) {
	const t = line.trim();
	if (!t) return false;
	if (SECTION_HEADER_RE.test(t)) return true;
	return /^(?:эпизод|часть|глава|episode|part|chapter)\s*\d+\s*[:.\-–—]/iu.test(t);
}

function isYoutubeShelfNoiseLine(text) {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s || s.length < 12) return false;
	const lower = s.toLocaleLowerCase();
	if (/\bновинка\b/iu.test(lower) || /\bавтодубляж\b/iu.test(lower)) return true;
	if (/\bnexta\b/iu.test(lower)) return true;
	if (/\d[\d\s,.]*\s*тыс\.?\s*(?:назад|[гдлм]\.?|дн\.?|мес\.?|л\.?)/iu.test(lower)) {
		return true;
	}
	const viewHits = (lower.match(/\d[\d\s,.]*\s*тыс/gu) ?? []).length;
	if (viewHits >= 2) return true;
	if (viewHits >= 1 && (s.match(/\s\/\s/g) ?? []).length >= 2 && s.length > 80) {
		return true;
	}
	return false;
}

function extractSpeechAfterShelf(line) {
	const openMatch = line.match(
		/(?:^|[\s])((?:лексей|алексей|как\s+бы|хочу\s+выразить|здравствуй|добрый\s+(?:день|вечер)|приветствую).+)$/iu,
	);
	if (!openMatch || openMatch.index === undefined) return null;
	const head = line.slice(0, openMatch.index).trim();
	if (head.length >= 20 && isYoutubeShelfNoiseLine(head)) {
		return openMatch[1].trim();
	}
	if (isYoutubeShelfNoiseLine(line) && openMatch.index > 20) {
		return openMatch[1].trim();
	}
	return null;
}

function stripLeadingYoutubeShelf(text) {
	const lines = text
		.replace(/\r\n/g, "\n")
		.split(/\n+/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return "";
	const rewritten = lines.map((line) => extractSpeechAfterShelf(line) ?? line);
	let start = 0;
	while (start < rewritten.length && isYoutubeShelfNoiseLine(rewritten[start])) {
		if (
			/хочу\s+выразить|как\s+бы\s+я|здравствуй|приветствую/iu.test(
				rewritten[start],
			) &&
			!/\d[\d\s,.]*\s*тыс/iu.test(rewritten[start])
		) {
			break;
		}
		start += 1;
	}
	if (start < rewritten.length) {
		for (let i = start; i < Math.min(rewritten.length, start + 12); i += 1) {
			if (
				/хочу\s+выразить|как\s+бы\s+я\s+шёл|как\s+бы\s+я\s+шел|здравствуй/iu.test(
					rewritten[i],
				)
			) {
				start = i;
				break;
			}
		}
	}
	return rewritten.slice(start).join("\n");
}

function cleanYouTubeTranscriptText(raw) {
	const chromeOnly =
		/^(показать текст видео|поиск в расшифровке|show transcript|search in transcript|в этом видео)$/iu;
	const pre = stripLeadingYoutubeShelf(raw.replace(/\r\n/g, "\n"));
	const blocks = [];
	let title = "";
	let parts = [];
	const flush = () => {
		if (title || parts.length > 0) blocks.push({ title, parts });
		title = "";
		parts = [];
	};
	for (const rawLine of pre.split(/\n+/)) {
		const original = rawLine.trim();
		if (!original) continue;
		if (isPureTimestampLine(original)) continue;
		if (isYoutubeShelfNoiseLine(original)) continue;
		if (isTranscriptSectionHeader(original)) {
			flush();
			title = scrubAllTimecodes(original) || original.trim();
			continue;
		}
		const line = scrubAllTimecodes(original);
		if (!line || chromeOnly.test(line)) continue;
		if (isYoutubeShelfNoiseLine(line)) continue;
		if (isTranscriptSectionHeader(line)) {
			flush();
			title = line;
			continue;
		}
		if (line.length < 4) continue;
		if ((line.match(/[\p{L}]/gu) ?? []).length < 3) continue;
		const prev = parts[parts.length - 1];
		if (prev && prev.toLocaleLowerCase() === line.toLocaleLowerCase()) continue;
		parts.push(line);
	}
	flush();
	const out = [];
	for (const block of blocks) {
		const cleanedLines = block.parts
			.map((p) => scrubAllTimecodes(p).replace(/\s+/g, " ").trim())
			.filter((p) => p && !isYoutubeShelfNoiseLine(p));
		const body = stripLeadingYoutubeShelf(cleanedLines.join("\n"))
			.split(/\n+/)
			.map((l) => l.trim())
			.filter(Boolean)
			.join("\n");
		if (block.title && body) out.push(`${block.title}\n${body}`);
		else if (block.title) out.push(block.title);
		else if (body) out.push(body);
	}
	return out.join("\n\n");
}

function assertIncludes(got, expected, label) {
	const ok =
		expected === ""
			? got === ""
			: got.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
	if (!ok) {
		console.error("FAIL", label, { expected, got });
		process.exitCode = 1;
		return;
	}
	console.log("OK", label, "→", JSON.stringify(got));
}

function assertNo(got, banned, label) {
	const ok = !got.toLocaleLowerCase().includes(banned.toLocaleLowerCase());
	if (!ok) {
		console.error("FAIL", label, { banned, got });
		process.exitCode = 1;
		return;
	}
	console.log("OK", label);
}

// Line-level scrub — stamp patterns only (neutral speech, no video dumps).
const cases = [
	["Минут 28 секундкоторая у нас есть сейчас", "которая у нас есть сейчас"],
	["0:000 секундпривет это тест", "привет это тест"],
	["1:02", ""],
	["0:00:05", ""],
	["Секундтекст без цифры", "текст без цифры"],
	["4 минуты меня пригласили сюда", "меня пригласили сюда"],
	["0:33 секундыНачало рассказа сегодня", "Начало рассказа"],
	["минута 1 текст про тему урока", "текст про тему урока"],
	["0:07 что вы сделали от имени всех нас", "что вы сделали"],
	["0:00 ведущий хочу начать выступление", "ведущий хочу начать"],
];

for (const [input, expected] of cases) {
	const got = cleanASRTimecodesLine(input);
	assertIncludes(got, expected, JSON.stringify(input));
	if (/^\d/.test(input.trim()) || /:\d/.test(input)) {
		assertNo(got, "0:", `no clock in ${JSON.stringify(input)}`);
	}
}

// Episode header preserved (number may stay with colon form)
const ep = cleanASRTimecodesLine("Эпизод 1: вступление");
assertIncludes(ep, "вступление", "episode header keeps title text");

// Full transcript: glue after scrub, no stamp crumbs
const multi = cleanYouTubeTranscriptText(`
Эпизод 1: вступление
0:00
0:33 секундыНачало рассказа о теме урока.
минута 1 Он привёл три коротких примера.
Эпизод 2: дальше
1:02
Ещё один факт о предмете.
`);

assertIncludes(multi, "Эпизод 1", "keeps episode 1 header");
assertIncludes(multi, "Начало рассказа", "glued speech after stamp survives");
assertIncludes(multi, "примера", "body text survives");
assertNo(multi, "0:33", "no 0:33 residual");
assertNo(multi, "секунды", "no секунды residual");
assertNo(multi, "минута", "no минута residual");

const ep1Block = multi.split(/\n\n/)[0] ?? multi;
const lines = ep1Block.split("\n");
if (lines.length < 2) {
	console.error("FAIL ep1 should be header + body lines", ep1Block);
	process.exitCode = 1;
} else {
	console.log("OK ep1 structure header+glued body");
}

function assert(cond, msg) {
	if (!cond) {
		console.error("FAIL:", msg);
		process.exitCode = 1;
		return;
	}
	console.log("OK:", msg);
}

// Shelf: structural UI markers only
const shelfBlob =
	"Первый ролик / Канал Альфа123 тыс. назадНовинка Второй ролик / Канал Бета456 тыс. г. назад Третий ролик / Канал Гамма78 тыс. дн. назад";
assert(
	isYoutubeShelfNoiseLine(shelfBlob) === true,
	"glued rec shelf detected as noise",
);

const polluted = cleanYouTubeTranscriptText(`${shelfBlob}
приветствую вас сегодня мы разберём тему урока подробно
как бы я начал с простого примера и плана на сегодня
далее объясняют основные правила поведения в этом случае
`);
assertIncludes(polluted, "разберём тему", "speech survives after shelf strip");
assertIncludes(polluted, "основные правила", "thesis body survives");
assertNo(polluted, "тыс. назад", "no view-count shelf in clean output");
assertNo(polluted, "Новинка", "no Новинка shelf chrome");
assertNo(polluted, "Канал Альфа", "no unrelated rec title in clean output");

const gluedOne = cleanYouTubeTranscriptText(
	`${shelfBlob} хочу выразить вам благодарность за внимание к теме`,
);
assertIncludes(gluedOne, "хочу выразить", "single-line speech after shelf");
assertNo(gluedOne, "Новинка", "single-line: no shelf chrome");

if (!process.exitCode) {
	console.log("\nAll ASR clean fixtures passed");
}
