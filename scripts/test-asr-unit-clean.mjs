/**
 * Fixtures for ASR unit cleaners (mirrors src/lib/asrCleaner.ts).
 * Run: node scripts/test-asr-unit-clean.mjs
 */

const FILLER_SINGLE = new Set([
	"ну",
	"вот",
	"типа",
	"типо",
	"короче",
	"короч",
	"значит",
	"блин",
	"вообще",
	"просто",
	"ладно",
	"давайте",
	"погнали",
	"слушай",
	"собственно",
	"да",
	"нет",
	"а",
	"и",
	"э",
	"ээ",
	"эээ",
	"эм",
	"эмм",
	"мм",
	"ммм",
	"хм",
	"хмм",
	"угу",
	"ага",
	"ок",
	"окей",
]);

const FILLER_PHRASES = [
	["на", "самом", "деле"],
	["так", "сказать"],
	["в", "таком", "духе"],
	["это", "самое"],
	["как", "то", "так"],
	["как-то", "так"],
	["в", "общем"],
	["в", "целом"],
	["как", "бы"],
	["по", "ходу"],
	["допустим"],
].sort((a, b) => b.length - a.length);

function tokenizeWords(text) {
	return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
}

function ngramsEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
	return true;
}

function collapseAsrLoops(text, minRepeat = 3, maxNgram = 4) {
	const words = text.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu);
	if (!words || words.length === 0) return text.trim();
	const lower = words.map((w) => w.toLocaleLowerCase());
	const result = [];
	let i = 0;
	while (i < words.length) {
		let matched = false;
		const maxN = Math.min(maxNgram, Math.floor((words.length - i) / minRepeat));
		for (let n = maxN; n >= 1; n -= 1) {
			if (i + n * minRepeat > words.length) continue;
			const ngramLower = lower.slice(i, i + n);
			let allMatch = true;
			for (let k = 1; k < minRepeat; k += 1) {
				const block = lower.slice(i + k * n, i + (k + 1) * n);
				if (!ngramsEqual(ngramLower, block)) {
					allMatch = false;
					break;
				}
			}
			if (!allMatch) continue;
			let run = minRepeat;
			while (i + (run + 1) * n <= words.length) {
				const block = lower.slice(i + run * n, i + (run + 1) * n);
				if (!ngramsEqual(ngramLower, block)) break;
				run += 1;
			}
			for (let t = 0; t < n; t += 1) result.push(words[i + t]);
			i += run * n;
			matched = true;
			break;
		}
		if (!matched) {
			result.push(words[i]);
			i += 1;
		}
	}
	return result.join(" ").replace(/\s+/g, " ").trim();
}

function scanFillers(text) {
	const words = tokenizeWords(text);
	if (words.length === 0) return { fillerCount: 0, totalTokens: 0, contentTokens: 0 };
	let fillerCount = 0;
	let contentTokens = 0;
	let i = 0;
	while (i < words.length) {
		let matchedPhrase = false;
		for (const phrase of FILLER_PHRASES) {
			if (i + phrase.length > words.length) continue;
			let ok = true;
			for (let p = 0; p < phrase.length; p += 1) {
				if (words[i + p] !== phrase[p]) {
					ok = false;
					break;
				}
			}
			if (ok) {
				fillerCount += 1;
				i += phrase.length;
				matchedPhrase = true;
				break;
			}
		}
		if (matchedPhrase) continue;
		const w = words[i];
		if (FILLER_SINGLE.has(w) || /^(э+|м+|хм+)$/u.test(w)) fillerCount += 1;
		else if (w.length >= 3) contentTokens += 1;
		i += 1;
	}
	return { fillerCount, totalTokens: words.length, contentTokens };
}

function fillerRatio(text) {
	const words = tokenizeWords(text);
	if (words.length === 0) return 1;
	let covered = 0;
	let i = 0;
	while (i < words.length) {
		let matchedPhrase = false;
		for (const phrase of FILLER_PHRASES) {
			if (i + phrase.length > words.length) continue;
			let ok = true;
			for (let p = 0; p < phrase.length; p += 1) {
				if (words[i + p] !== phrase[p]) {
					ok = false;
					break;
				}
			}
			if (ok) {
				covered += phrase.length;
				i += phrase.length;
				matchedPhrase = true;
				break;
			}
		}
		if (matchedPhrase) continue;
		const w = words[i];
		if (FILLER_SINGLE.has(w) || /^(э+|м+|хм+)$/u.test(w)) covered += 1;
		i += 1;
	}
	return covered / words.length;
}

function isMostlyFiller(text) {
	const collapsed = collapseAsrLoops(text);
	const scan = scanFillers(collapsed);
	if (scan.totalTokens === 0) return true;
	if (scan.contentTokens >= 3) return false;
	const ratio = fillerRatio(collapsed);
	const threshold = scan.totalTokens < 8 ? 0.3 : 0.4;
	return ratio > threshold;
}

function fixAsrGlitches(text) {
	let s = text.replace(/\s+/g, " ").trim();
	if (!s) return "";
	s = s.replace(
		/\[(?:аплодисменты|смех|музыка|applause|laughter|music)\]|\((?:аплодисменты|смех|музыка|applause)\)/giu,
		" ",
	);
	s = s.replace(/(?:аплодисменты|смех|музыка|applause|laughter)(?=\p{L})/giu, " ");
	s = s.replace(/(?:^|[\s])(?:аплодисменты|смех)(?=[\s.,!?]|$)/giu, " ");
	for (let pass = 0; pass < 4; pass += 1) {
		const before = s;
		s = s.replace(/(\p{L}{2,})(?:\s+\1)+/giu, "$1");
		if (s === before) break;
	}
	s = s.replace(/(^|[\s.,;:!?…\-–—])еловек/giu, "$1человек");
	s = s.replace(/(^|[\s.,;:!?…\-–—])еловеч/giu, "$1человеч");
	s = s.replace(/(^|[\s.,;:!?…\-–—])исле(?=[\s.,;:!?…]|$)/giu, "$1числе");
	s = s.replace(/(^|[\s.,;:!?…\-–—])ётк/giu, "$1чётк");
	return s.replace(/\s+/g, " ").trim();
}

function isHardDropUnit(text) {
	const lower = text.toLocaleLowerCase();
	const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	if (words.length < 8) return true;
	if (/хочу\s+выразить|великое\s+почтение/iu.test(lower) && words.length < 35) {
		return true;
	}
	// Short aside only
	if (/вы\s+слышите/iu.test(lower) && words.length < 18) return true;
	const first = words[0] ?? "";
	const content = words.filter((w) => w.length >= 5).length;
	const weak =
		/^(и|а|но|эти|потом|вести|то|ну|говорил|складываются|распространено|буквально)$/u;
	if (weak.test(first) && content < 6) return true;
	return false;
}

function sanitizeSummaryUnit(text) {
	let s = text.replace(/\s+/g, " ").trim();
	if (!s) return null;
	s = collapseAsrLoops(s);
	s = fixAsrGlitches(s);
	s = s.replace(/\s+/g, " ").trim();
	if (s.length < 12) return null;
	if ((s.match(/[\p{L}]/gu) ?? []).length < 8) return null;
	const words = tokenizeWords(s);
	if (words.length < 8) return null;
	const scan = scanFillers(s);
	if (scan.contentTokens < 4) return null;
	if (isMostlyFiller(s)) return null;
	const unique = new Set(words);
	if (words.length >= 3 && unique.size === 1) return null;
	return s;
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

// --- collapseAsrLoops ---
assert(
	collapseAsrLoops("в целом в целом в целом в целом в целом") === "в целом",
	'collapse "в целом"×5 → "в целом"',
);
assert(
	collapseAsrLoops("чуть чуть чуть чуть") === "чуть",
	'collapse "чуть"×4 → "чуть"',
);
// collapseAsrLoops requires ≥3; doubles handled by fixAsrGlitches
assert(
	collapseAsrLoops("очень очень важно") === "очень очень важно",
	"double word only (2×) unchanged by n-gram≥3 collapse",
);
assert(
	fixAsrGlitches("основные основные знания подробно описывают тему") ===
		"основные знания подробно описывают тему",
	"immediate doubles collapsed by fixAsrGlitches",
);
assert(
	fixAsrGlitches("[аплодисменты] краткий итог занятия большой")
		.toLocaleLowerCase()
		.includes("итог"),
	"applause marker stripped",
);
assert(
	!fixAsrGlitches("[аплодисменты] краткий итог занятия")
		.toLocaleLowerCase()
		.includes("аплодисменты"),
	"no applause residual",
);
assert(
	collapseAsrLoops("историки спорят почему") === "историки спорят почему",
	"no loop unchanged",
);

// --- filler / sanitize ---
assert(
	sanitizeSummaryUnit("в целом в целом в целом в целом в целом") === null,
	"pure в целом loop dropped",
);
assert(
	sanitizeSummaryUnit("ну короче типа в общем так сказать да") === null,
	"filler-only sentence dropped",
);
assert(
	sanitizeSummaryUnit(
		"ну историки спорят почему самая частая версия этого события в науке",
	) !== null,
	"content with light filler kept (≥8 tokens)",
);
assert(
	sanitizeSummaryUnit(
		"И были измотаны военными походами но это немного странно по крайней мере с моей стороны",
	) !== null,
	"campaign content kept",
);

const shortLoop = sanitizeSummaryUnit("чуть чуть чуть чуть");
assert(
	shortLoop === null,
	"collapsed short stutter not a bullet unit",
);

// Promo / ad units (generic patterns)
function isPromoOrAdUnit(text) {
	const lower = text.toLocaleLowerCase();
	const strongPatterns = [
		/переход(?:ите|и)\s+по\s+ссылк/u,
		/ссылк[аеиу]\s+в\s+описани/u,
		/промо[\s-]?код/u,
		/\bспонсор(?:\s+ролика|\s+этого)?\b/u,
		/\bреклам[аыуе]\b/u,
		/скача(?:й|йте)\s+приложени/u,
		/подписыва(?:йтесь|йся)/u,
		/рассрочк/u,
		/оплат[аыуе]\s+част/u,
	];
	let hits = 0;
	for (const re of strongPatterns) {
		if (re.test(lower)) hits += 1;
	}
	const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	if (hits >= 2) return true;
	if (hits >= 1 && words.length <= 25) return true;
	return false;
}

assert(
	isPromoOrAdUnit(
		"Переходите по ссылке в описании и скачайте приложение для оплаты частями",
	) === true,
	"promo CTA unit flagged",
);
assert(
	isPromoOrAdUnit(
		"Кока-кола появилась в конце девятнадцатого века как лекарственный напиток",
	) === false,
	"content about cola not flagged as promo",
);

assert(
	fixAsrGlitches("еловека то есть как правильно").includes("человека"),
	"Cyrillic-safe repair еловека → человека",
);
assert(
	isHardDropUnit(
		"ведущий хочу выразить вам своё великое почтение вы привели меня к теме хочу вам поклониться за то",
	) === true,
	"greeting unit hard-dropped",
);
assert(
	isHardDropUnit(
		"объясняют некие законы поведения чистой жизни которые очень похожи на то что обсуждали на прошлом уроке",
	) === false,
	"thesis unit not hard-dropped",
);
assert(
	isHardDropUnit(
		"эти и в первой и во второй части его только нет да Хорошо я вам скажу так когда вы говорите о старых традициях подробно",
	) === false,
	"long weak-opener unit kept (soft penalty only)",
);
assert(
	isHardDropUnit(
		"говорил Неважно кто",
	) === true,
	"very short mid-phrase hard-dropped",
);
assert(
	isHardDropUnit(
		"пищу слышите Если кто-то",
	) === true,
	"short вы слышите aside hard-dropped",
);
assert(
	isHardDropUnit(
		"музыка фоновая даже музыка вы слышите идёт разрушение изнутри и оно выражается в этих внешних формах но будьте осторожны с влиятельными представителями",
	) === false,
	"long unit with вы слышите not hard-dropped",
);

const CLOSED_CLASS_LAST_RE =
	/^(и|а|но|что|как|это|ваш[аеиух]*|наш[аеиух]*|то|ну|вот|же|бы|ли|да|в|на|о|к|с|из|у|не|для|при|под|над|от|по|со|об|про|без|до|после|через|очень|сильно|именно|совсем|ещё|еще|более|менее|хотя|данный|дан|дал|дали)$/u;
const FINITE_VERB_LAST_RE =
	/^[\p{L}]{4,}(?:ает|яет|ует|иет|ают|яют|уют|ит|ет|ут|ют|ал|ил|ел|ыл|ала|ила|ела|ыла|али|или|ели|ыли|лся|лась|лось|лись|ёт|ешь|ете|ем)$/u;
const ADJECTIVE_LIKE_LAST_RE =
	/^[\p{L}]{5,}(?:ский|ской|цкий|цкой|ный|ной|ний|овый|евый|ический|еский|ая|ое|ые|ый|ий|ых|их|кий|тый|мый|тельной|тельная|тельное)$/u;
const INFINITIVE_OPENER_RE = /^(?:[\p{L}]{3,}(?:ть|ться|ти|чь))$/u;
// Closed-class / speech only — no topic nouns.
const MID_PHRASE_OPENERS =
	/^(и|а|но|эти|потом|то|ну|же|бы|ли|да|в|за|с|из|у|о|к|от|по|для|при|под|над|на|со|об|про|без|до|после|через|между|среди|слышите|говорил|говорили|сказал|сказали)$/u;

function startsMidPhraseOpener(text) {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return false;
	const lower = s.toLocaleLowerCase();
	if (/^то\s+есть(?:\s|$)/iu.test(lower)) return false;
	if (/^что\s+вы(?:\s|$)/iu.test(lower)) return true;
	if (/^слышите(?:\s|$)/iu.test(lower)) return true;
	const first = (s.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])[0] ?? "";
	if (MID_PHRASE_OPENERS.test(first)) return true;
	if (INFINITIVE_OPENER_RE.test(first)) return true;
	return false;
}

function isBulletEligible(text) {
	const lower = text.toLocaleLowerCase();
	const words = lower.match(/[\p{L}\p{N}]+/gu) ?? [];
	if (words.length < 10) return false;
	if (isHardDropUnit(text)) return false;
	if (/хочу\s+выразить|великое\s+почтение/iu.test(text)) return false;
	if (/вы\s+слышите/iu.test(lower)) return false;
	if (/^что\s+вы(?:\s|$)/iu.test(lower)) return false;
	// Structural mid-openers only (closed-class / infinitive / NP-tail).
	if (startsMidPhraseOpener(text)) return false;
	// как / буквально soft openers remain allowed
	return true;
}

assert(
	isBulletEligible(
		"объясняют некие законы поведения чистой жизни которые очень похожи на то что обсуждали на прошлом уроке",
	) === true,
	"thesis bullet eligible",
);
assert(
	isBulletEligible(
		"как бы я начал урок издалека сейчас достаточно популярна у нас первая тема курса достаточно много лекторов",
	) === true,
	"как бы opener still eligible",
);
assert(
	isBulletEligible(
		"буквально там про каждую деталь всё сказано и основные знания они тоже подробнейшим образом описывают жизнь человека",
	) === true,
	"буквально opener still eligible",
);
assert(
	isBulletEligible(
		"вести себя вот в этом мире и ещё может быть параллельно тоже вот эти вот лекторы говорят",
	) === false,
	"mid-phrase вести not bullet-eligible",
);
assert(
	isBulletEligible(
		"эти и в первой части чего только нет да Хорошо я вам скажу",
	) === false,
	"mid-phrase эти not bullet-eligible",
);
assert(
	isBulletEligible(
		"музыка фоновая даже музыка вы слышите идёт разрушение изнутри и шум",
	) === false,
	"вы слышите chat not bullet-eligible",
);
assert(
	isBulletEligible(
		"что вы сами например знаете что говорил я сам всего достиг я сам всё получил да я сам достиг цели",
	) === false,
	"что вы digression not bullet-eligible",
);

function endsIncomplete(text) {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return true;
	if (/[.!?…]$/u.test(s)) return false;
	const words = s.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	if (words.length === 0) return true;
	const last = words[words.length - 1] ?? "";
	const penult = words.length >= 2 ? words[words.length - 2] : "";
	if (last.length <= 3) return true;
	if (CLOSED_CLASS_LAST_RE.test(last)) return true;
	if (FINITE_VERB_LAST_RE.test(last)) return true;
	if (words.length >= 4 && ADJECTIVE_LIKE_LAST_RE.test(last)) return true;
	if (
		words.length >= 4 &&
		ADJECTIVE_LIKE_LAST_RE.test(penult) &&
		last.length <= 10 &&
		!CLOSED_CLASS_LAST_RE.test(last)
	) {
		return true;
	}
	if (
		words.length >= 4 &&
		/^(?:дан|дал|дал[аи]|не|как|что|хотя|очень|совсем)$/u.test(penult) &&
		last.length <= 10
	) {
		return true;
	}
	return false;
}

function startsContinuationOpener(text) {
	if (startsMidPhraseOpener(text)) return true;
	const first = (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])[0] ?? "";
	return /^(буквально|далее|также|кроме|причём|причем|именно|поэтому|однако|значит|итак|смотрите)$/u.test(
		first,
	);
}

function attachMidPhraseOpeners(units, maxChars = 720) {
	if (units.length <= 1) return units;
	const hardCap = Math.max(maxChars, 900);
	const out = [];
	for (const raw of units) {
		const cur = raw.replace(/\s+/g, " ").trim();
		if (!cur) continue;
		const prev = out.length > 0 ? out[out.length - 1] : "";
		const shouldAttach =
			out.length > 0 &&
			(startsMidPhraseOpener(cur) ||
				(endsIncomplete(prev) && startsContinuationOpener(cur))) &&
			prev.length + 1 + cur.length <= hardCap;
		if (shouldAttach) {
			out[out.length - 1] = `${prev} ${cur}`;
			continue;
		}
		out.push(cur);
	}
	return out;
}

function mergeIncompleteUnits(units, maxChars = 720) {
	const softCap = Math.max(maxChars, 720);
	const hardCap = Math.max(softCap, 900);
	const out = [];
	let i = 0;
	while (i < units.length) {
		let cur = units[i];
		let forcedOnce = false;
		while (i + 1 < units.length && endsIncomplete(cur)) {
			const next = units[i + 1];
			const combined = cur.length + 1 + next.length;
			const allow = combined <= softCap || (!forcedOnce && combined <= hardCap);
			if (!allow) break;
			i += 1;
			forcedOnce = true;
			cur = `${cur} ${next}`;
		}
		out.push(cur);
		i += 1;
	}
	return attachMidPhraseOpeners(out, hardCap);
}

function trimTrailingTopicJump(text) {
	const s = text.replace(/\s+/g, " ").trim();
	if (s.length < 80) return s;
	const closers = [
		/^(.*?это очень важно)\s+(.+)$/iu,
		/^(.*?вот в чём дело)\s+(.+)$/iu,
		/^(.*?вот в чем дело)\s+(.+)$/iu,
	];
	for (const re of closers) {
		const m = s.match(re);
		if (m && m[1].length >= 40 && m[2].length >= 12) {
			return m[1].trim();
		}
	}
	return s;
}

const joined = mergeIncompleteUnits([
	"объясняют законы чистой жизни похожи на то что обсуждали раньше Мне кажется что вот одна из причин что в современном мире тема не очень сильно",
	"распространено то что там не Дан чёткий свод законов как себя вести как у соседей",
	"буквально там про каждую деталь всё сказано и основные знания описывают жизнь",
]);
assert(
	joined.length === 2 &&
		/сильно\s+распространено/i.test(joined[0]) &&
		/деталю|деталью|деталь/i.test(joined[1]),
	"incomplete «сильно» merges with next unit",
);

// Long thesis pair that previously failed at maxChars=420.
const longA =
	"объясняют В общем некие законы поведения именно чистой жизни которые очень похожи на то что обсуждали на прошлом уроке Мне кажется что вот одна из причин что в современном мире тема не очень сильно";
const longB =
	"распространено то что там ну как бы не Дан чёткий свод законов как себя вести как допустим есть у соседей есть другой свод раза толще чем наш текст там всё прописано как че себя вести если взять другие трактаты там";
const longJoined = mergeIncompleteUnits([longA, longB]);
assert(
	longJoined.length === 1 &&
		/сильно\s+распространено/i.test(longJoined[0]) &&
		/свод законов/i.test(longJoined[0]),
	"long thesis pair сильно|распространено merges under raised cap",
);

const reverseJoined = mergeIncompleteUnits([
	"полное непонимание как себя вести в материальном мире более-менее чётких правил поведения",
	"вести себя вот в этом мире и ещё может быть параллельно тоже вот эти вот лекторы говорят что автор ходил в другие страны",
	"эти и в первой и во второй части чего только нет да Хорошо я вам скажу так когда вы говорите о старых традициях",
]);
assert(
	reverseJoined.length === 1 &&
		/непонимание/i.test(reverseJoined[0]) &&
		/вести себя/i.test(reverseJoined[0]) &&
		/первой/i.test(reverseJoined[0]),
	"mid-phrase вести/эти reverse-merge onto previous unit",
);

const trimmed = trimTrailingTopicJump(
	"по итогу всей лекции этой модели этого нет вот в чём дело Так что там всё совсем не просто очень а правило что у нас очень много правил К сожалению даже Слишком много правил Вот и мы сейчас до чего дошли что уже лишний шум в конце вот",
);
assert(
	/вот в чём дело$/i.test(trimmed) && !/лишний шум/i.test(trimmed),
	"trim drops long digression tail after «вот в чём дело»",
);

assert(
	isBulletEligible(
		"в этих внешних формах но в отношении будьте осторожны с влиятельными представителями темы",
	) === false,
	"preposition mid-opener not bullet-eligible",
);
assert(
	isBulletEligible(
		"бы книгу правил только сколько там постановлений соборных и местных",
	) === false,
	"particle mid-opener not bullet-eligible",
);
assert(
	startsMidPhraseOpener("вести себя вот в этом мире") === true,
	"startsMidPhraseOpener detects infinitive вести",
);
assert(
	startsMidPhraseOpener(
		"как бы я начал урок издалека сейчас достаточно популярна традиция",
	) === false,
	"startsMidPhraseOpener allows как бы thesis",
);

function wouldEmitBullet(text) {
	return isBulletEligible(text);
}
// Structural mid-openers only (no topic-word list).
const badOpeners = [
	"вести себя вот в этом мире и ещё может быть параллельно тоже вот эти вот лекторы",
	"эти и в первой части чего только нет да Хорошо я вам скажу",
	"в этих внешних формах но в отношении будьте осторожны один из самых",
	"что вы сами например знаете что говорил я сам всего достиг цели",
	"бы книгу правил только сколько там постановлений соборных",
];
for (const b of badOpeners) {
	assert(wouldEmitBullet(b) === false, `no emit: ${b.slice(0, 24)}…`);
}

// Incomplete mid-clause cuts (morphology / closed-class — mirrors production).
function isIncompleteThoughtLocal(text) {
	const s = text.replace(/\s+/g, " ").trim();
	if (startsMidPhraseOpener(s)) return true;
	if (endsIncomplete(s)) return true;
	if (/[.!?…]$/u.test(s)) return false;
	const words = s.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	if (words.length < 8) return true;
	if (/(?:^|\s)(?:не\s+)?(?:очень|совсем|более|менее)\s+[\p{L}]{3,}$/iu.test(s)) {
		return true;
	}
	return false;
}
assert(
	isIncompleteThoughtLocal(
		"в современном мире тема не очень сильно",
	) === true,
	"mid-clause intensifier tail is incomplete thought",
);
assert(
	endsIncomplete(
		"модификации которые здесь существуют приспособительной христианской",
	) === true,
	"adjective-like last token is incomplete (morphology)",
);
assert(
	endsIncomplete("из семени постепенно начинает") === true,
	"finite-verb last token is incomplete (morphology)",
);
assert(
	isIncompleteThoughtLocal(
		"объясняют некие законы поведения чистой жизни которые очень похожи на то что обсуждали на прошлом уроке.",
	) === false,
	"complete sentence with period is not incomplete",
);

// --- rejoinInvalidChunks / doubleMerge (keep in sync with asrCleaner.ts) ---
function rejoinInvalidChunks(chunks, maxChars = 900) {
	if (chunks.length <= 1) return chunks;
	const out = [];
	for (const raw of chunks) {
		const cur = raw.replace(/\s+/g, " ").trim();
		if (!cur) continue;
		const prev = out.length > 0 ? out[out.length - 1] : "";
		const shouldJoin =
			out.length > 0 &&
			prev.length + 1 + cur.length <= maxChars &&
			(startsMidPhraseOpener(cur) ||
				isIncompleteThoughtLocal(cur) ||
				endsIncomplete(prev) ||
				startsContinuationOpener(cur));
		if (shouldJoin) {
			out[out.length - 1] = `${prev} ${cur}`;
			continue;
		}
		out.push(cur);
	}
	return out;
}

function doubleMergeIncompleteUnits(units, maxChars = 720) {
	const once = mergeIncompleteUnits(units, maxChars);
	return mergeIncompleteUnits(once, maxChars);
}

// Mid-split: second chunk opens mid-phrase → rejoin
const rejoined = rejoinInvalidChunks([
	"объясняют некие законы поведения чистой жизни которые очень похожи на то что обсуждали раньше и поэтому тема",
	"вести себя вот в этом мире нужно по простым правилам без лишнего шума",
]);
assert(
	rejoined.length === 1 &&
		/объясняют/i.test(rejoined[0]) &&
		/вести себя/i.test(rejoined[0]) &&
		!startsMidPhraseOpener(rejoined[0]),
	"rejoinInvalidChunks merges mid-phrase opener onto previous",
);

// Double merge: incomplete end + continuation after attach
const doubleMerged = doubleMergeIncompleteUnits([
	"мне кажется что вот одна из причин что в современном мире тема не очень сильно",
	"распространено то что там не дан чёткий свод законов как себя вести",
]);
assert(
	doubleMerged.length === 1 && /сильно\s+распространено/i.test(doubleMerged[0]),
	"doubleMergeIncompleteUnits joins incomplete + continuation",
);

if (!process.exitCode) {
	console.log("\nAll ASR unit-clean fixtures passed.");
}
