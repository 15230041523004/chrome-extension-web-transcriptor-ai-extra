/**
 * Pure ASR text cleaners for extractive summarization.
 * Run before E5 embeddings so loops/fillers never dominate LexRank.
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

/** Multiword fillers, longer first for matching. */
const FILLER_PHRASES: string[][] = [
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

const UNIT_JACCARD_DEDUP = 0.82;

export function tokenizeWords(text: string): string[] {
	return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
}

function ngramsEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Collapse ASR stutter loops: same 1–4 word n-gram repeated ≥ minRepeat times.
 * Prefers longer n-grams first so "в целом" collapses before single "в".
 */
export function collapseAsrLoops(
	text: string,
	minRepeat = 3,
	maxNgram = 4,
): string {
	const words = text.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu);
	if (!words || words.length === 0) return text.trim();

	const lower = words.map((w) => w.toLocaleLowerCase());
	const result: string[] = [];
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

			// Extend full run beyond minRepeat.
			let run = minRepeat;
			while (i + (run + 1) * n <= words.length) {
				const block = lower.slice(i + run * n, i + (run + 1) * n);
				if (!ngramsEqual(ngramLower, block)) break;
				run += 1;
			}

			// Emit original casing from first occurrence.
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

type FillerScan = {
	fillerCount: number;
	totalTokens: number;
	contentTokens: number;
};

/**
 * Count filler words/phrases vs content tokens (phrases consume multiple words as one filler).
 */
export function scanFillers(text: string): FillerScan {
	const words = tokenizeWords(text);
	if (words.length === 0) {
		return { fillerCount: 0, totalTokens: 0, contentTokens: 0 };
	}

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
		if (FILLER_SINGLE.has(w) || /^(э+|м+|хм+)$/u.test(w)) {
			fillerCount += 1;
		} else if (w.length >= 3) {
			contentTokens += 1;
		}
		i += 1;
	}

	return {
		fillerCount,
		totalTokens: words.length,
		contentTokens,
	};
}

export function fillerRatio(text: string): number {
	// Word-level cover: multiword phrases count as all covered tokens.
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

export function isMostlyFiller(text: string): boolean {
	const collapsed = collapseAsrLoops(text);
	const scan = scanFillers(collapsed);
	if (scan.totalTokens === 0) return true;
	// Keep if enough real content remains.
	if (scan.contentTokens >= 3) return false;
	const ratio = fillerRatio(collapsed);
	const threshold = scan.totalTokens < 8 ? 0.3 : 0.4;
	return ratio > threshold;
}

function tokenSetForDedup(text: string): Set<string> {
	return new Set(tokenizeWords(text).filter((w) => w.length >= 3));
}

function jaccardSets(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const token of left) {
		if (right.has(token)) intersection += 1;
	}
	return intersection / (left.size + right.size - intersection);
}

/** Non-speech stage labels (RU/EN), including bracket forms. */
const STAGE_LABEL_RE =
	/\[(?:аплодисменты|смех|музыка|шум|неразборчиво|applause|laughter|music|crosstalk|inaudible|unk)\]|\((?:аплодисменты|смех|музыка|applause|laughter|music)\)/giu;

const STAGE_WORD_GLUE_RE =
	/(?:аплодисменты|смех|музыка|applause|laughter)(?=\p{L})/giu;

const STAGE_WORD_BARE_RE =
	/(?:^|[\s])(?:аплодисменты|смех)(?=[\s.,!?]|$)/giu;

const SECTION_LINE_RE =
	/^(?:эпизод|часть|глава|раздел|episode|part|chapter|section)\s*\d+\b/iu;

/**
 * Stage 2: mechanical ASR clean without dropping units (loops + doubles + stage labels).
 * Preserves episode header lines; cleans body text in place.
 */
export function applyMechanicalAsrClean(text: string): string {
	const chunks = text.split(/(\n+)/);
	const out: string[] = [];
	for (const chunk of chunks) {
		if (!chunk) continue;
		if (/^\n+$/.test(chunk)) {
			out.push(chunk);
			continue;
		}
		const trimmed = chunk.trim();
		if (!trimmed) continue;
		if (SECTION_LINE_RE.test(trimmed)) {
			out.push(trimmed);
			continue;
		}
		let s = collapseAsrLoops(trimmed);
		s = fixAsrGlitches(s);
		s = s.replace(/\s+/g, " ").trim();
		if (s) out.push(s);
	}
	return out
		.join("")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Collapse immediate repeated words (min 2) and strip stage/non-speech labels.
 * Complements collapseAsrLoops (n-gram ≥3) for residual ASR glitches.
 */
export function fixAsrGlitches(text: string): string {
	let s = text.replace(/\s+/g, " ").trim();
	if (!s) return "";

	s = s.replace(STAGE_LABEL_RE, " ");
	s = s.replace(STAGE_WORD_GLUE_RE, " ");
	s = s.replace(STAGE_WORD_BARE_RE, " ");

	// Immediate doubles: "основные основные" / "Да Да" (unicode letters).
	for (let pass = 0; pass < 4; pass += 1) {
		const before = s;
		s = s.replace(/(\p{L}{2,})(?:\s+\1)+/giu, "$1");
		if (s === before) break;
	}

	// High-precision RU ASR repairs. Avoid JS \b (ASCII-only word edges).
	s = s.replace(/(^|[\s.,;:!?…\-–—])еловек/giu, "$1человек");
	s = s.replace(/(^|[\s.,;:!?…\-–—])еловеч/giu, "$1человеч");
	s = s.replace(/(^|[\s.,;:!?…\-–—])исле(?=[\s.,;:!?…]|$)/giu, "$1числе");
	s = s.replace(/(^|[\s.,;:!?…\-–—])тности(?=[\s.,;:!?…]|$)/giu, "$1частности");
	s = s.replace(/(^|[\s.,;:!?…\-–—])ётк/giu, "$1чётк");
	s = s.replace(/(^|[\s.,;:!?…\-–—])е\s+себя(?=[\s.,;:!?…]|$)/giu, "$1себя");
	// "в ём" / bare ём → чём (common dropped "ч")
	s = s.replace(/(?:^|[\s])ём(?=[\s.,!?;:]|$)/giu, " чём");
	s = s.replace(/(?:^|[\s])в\s+ём(?=[\s.,!?;:]|$)/giu, " в чём");

	s = s.replace(/\s+/g, " ").trim();
	return s;
}

function endsWithDanglingConnector(text: string): boolean {
	const words = tokenizeWords(text);
	if (words.length === 0) return true;
	const last = words[words.length - 1];
	return /^(и|а|но|что|как|то|это|или|чтобы|потому)$/u.test(last);
}

/**
 * Generic YouTube sponsor / CTA noise (no product brand lists).
 * Drops units that are mostly commercial asides so they do not dominate LexRank.
 */
export function isPromoOrAdUnit(text: string): boolean {
	const lower = text.toLocaleLowerCase();
	const strongPatterns = [
		/переход(?:ите|и)\s+по\s+ссылк/u,
		/ссылк[аеиу]\s+в\s+описани/u,
		/link\s+in\s+(?:the\s+)?description/u,
		/промо[\s-]?код/u,
		/promo\s*code/u,
		/\bспонсор(?:\s+ролика|\s+этого)?\b/u,
		/\bреклам[аыуе]\b/u,
		/партн[её]рск/u,
		/скача(?:й|йте)\s+приложени/u,
		/install\s+(?:the\s+)?app/u,
		/подписыва(?:йтесь|йся)/u,
		/ставьте\s+лайк/u,
		/like\s+and\s+subscribe/u,
		/первый\s+взнос/u,
		/рассрочк/u,
		/без\s+переплат/u,
		/оплат[аыуе]\s+част/u,
		/кэшб[еэ]к|cashback/u,
	];
	let hits = 0;
	for (const re of strongPatterns) {
		if (re.test(lower)) hits += 1;
	}
	// One strong commercial CTA is enough for short units; need 2+ in longer speech.
	const words = tokenizeWords(text);
	if (hits >= 2) return true;
	if (hits >= 1 && words.length <= 25) return true;
	if (hits >= 1 && hits / Math.max(words.length, 1) >= 0.08) return true;
	return false;
}

/**
 * True mid-phrase caption crumbs — never emit as summary bullets.
 * Closed-class / speech only — no topic or content nouns from any single dump.
 */
const MID_PHRASE_OPENERS =
	/^(и|а|но|эти|потом|то|ну|же|бы|ли|да|в|за|с|из|у|о|к|от|по|для|при|под|над|на|со|об|про|без|до|после|через|между|среди|слышите|говорил|говорили|сказал|сказали)$/u;

/** Can start spoken clauses; soft-penalty only, still bullet-eligible. */
const SOFT_OPENERS =
	/^(как|если|это|вот|буквально|далее|также|кроме|причём|причем)$/u;

/**
 * Discourse structure glue for thesis bullets (genre-agnostic connectors only).
 */
const THESIS_GLUE_RE =
	/то\s+есть|потому\s+что|потому|получается\s+что|получается|в\s+отличие/iu;

/** Finite / past verb-looking first tokens that usually mark a mid-clause caption cut. */
const VERBISH_OPENER_RE =
	/^(?:[\p{L}]{4,}(?:ал|ил|ел|ыл|ала|ила|ела|ыла|али|или|ели|ыли|ют|ат|ят|ает|яет|ует|иет|ит|ет|ут|ют))$/u;

/** Infinitive-looking openers (caption cut mid-VP): «вести себя…», «делать так…». */
const INFINITIVE_OPENER_RE = /^(?:[\p{L}]{3,}(?:ть|ться|ти|чь))$/u;

/**
 * Closed-class last tokens (function words / particles / dangling connectors).
 * Never put content or domain nouns here — morphology covers open-class cuts.
 */
const CLOSED_CLASS_LAST_RE =
	/^(и|а|но|что|как|это|ваш[аеиух]*|наш[аеиух]*|то|ну|вот|же|бы|ли|да|в|на|о|к|с|из|у|не|для|при|под|над|от|по|со|об|про|без|до|после|через|очень|сильно|именно|совсем|ещё|еще|более|менее|хотя|данный|дан|дал|дали)$/u;

/** Finite / start-verb morphology as last token without period → incomplete clause. */
const FINITE_VERB_LAST_RE =
	/^[\p{L}]{4,}(?:ает|яет|ует|иет|ают|яют|уют|ит|ет|ут|ют|ал|ил|ел|ыл|ала|ила|ела|ыла|али|или|ели|ыли|лся|лась|лось|лись|ёт|ешь|ете|ем)$/u;

/**
 * Adjective-like morphology (mid-NP cut). Avoid bare «ей/ой» — they match genitive nouns (соседей).
 */
const ADJECTIVE_LIKE_LAST_RE =
	/^[\p{L}]{5,}(?:ский|ской|цкий|цкой|ный|ной|ний|овый|евый|ический|еский|ая|ое|ые|ый|ий|ых|их|кий|тый|мый|тельной|тельная|тельное)$/u;

/**
 * NP-tail openers: genitive/dative-looking first word + conjunction
 * (e.g. «психологии и происходит…», «любви там где…»).
 */
function startsNounPhraseTail(text: string): boolean {
	const words = tokenizeWords(text);
	if (words.length < 2) return false;
	const first = words[0] ?? "";
	const second = words[1] ?? "";
	// Genitive/dative/instrumental-ish endings after a cut mid-NP.
	if (
		/^[\p{L}]{5,}(?:ии|ий|ей|ям|ях|ами|ями|ого|ему|ому|ой|ых|их|ью|ом|ем)$/u.test(
			first,
		) &&
		/^(и|а|но|что|как|там|где|это|он|она|они|с|на|в)$/u.test(second)
	) {
		return true;
	}
	// Short genitive singular tails: «любви там», «веры нет» (not «обычаи и …»).
	// Do not treat conjunction «и|а|но» as the second token — too many nominative plurals.
	if (
		/^[\p{L}]{4,}и$/u.test(first) &&
		/^(там|где|нет|это)$/u.test(second) &&
		!SOFT_OPENERS.test(first)
	) {
		return true;
	}
	return false;
}

/** Structural mid-phrase start (emit + rejoin). */
export function isStructuralMidOpener(text: string): boolean {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return true;
	// Legitimate discourse openers that begin with a listed function word.
	// Avoid \b — it is ASCII-only and fails on Cyrillic in JS.
	if (/^то\s+есть(?:\s|$)/iu.test(s)) return false;
	if (/^потому\s+что(?:\s|$)/iu.test(s)) return false;
	if (/^в\s+отличие(?:\s|$)/iu.test(s)) return false;
	if (/^что\s+вы(?:\s|$)/iu.test(s)) return true;
	if (/^слышите(?:\s|$)/iu.test(s)) return true;
	const first = tokenizeWords(s)[0] ?? "";
	if (MID_PHRASE_OPENERS.test(first)) return true;
	if (INFINITIVE_OPENER_RE.test(first) && !hasThesisGlue(s)) return true;
	if (startsNounPhraseTail(s)) return true;
	return false;
}

export function hasThesisGlue(text: string): boolean {
	return THESIS_GLUE_RE.test(text);
}

const GREETING_OPEN_RE =
	/^(?:[\p{L}]{2,}\s+){0,4}(?:хочу\s+выразить|хочу\s+вам\s+поклон|великое\s+почтение|добрый\s+(?:день|вечер)|здравствуй)/iu;

/**
 * Soft ranking penalty 0..1 (higher = worse). Does not remove units from the pool.
 */
export function unitSoftPenalty(text: string): number {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return 1;
	const lower = s.toLocaleLowerCase();
	const words = tokenizeWords(s);
	let p = 0;

	if (/вы\s+слышите/iu.test(lower)) p += 0.35;
	if (/ой-ой-ой|ой\s+ой/iu.test(lower)) p += 0.3;
	const chatHits = (
		lower.match(/да\s+да\s+да|ну\s+как\s+вам|прям(?:о)?\s+сатанизм/gu) ?? []
	).length;
	if (chatHits >= 1) p += 0.2;
	if (chatHits >= 2) p += 0.15;

	const first = words[0] ?? "";
	const contentTokens = words.filter(
		(w) => w.length >= 5 && !FILLER_SINGLE.has(w),
	).length;
	if (MID_PHRASE_OPENERS.test(first)) p += 0.55;
	else if (SOFT_OPENERS.test(first)) p += 0.12;
	else if (contentTokens < 8) p += 0.1;

	const medium = words.filter((w) => w.length >= 4).length;
	const mediumRatio = words.length ? medium / words.length : 0;
	if (mediumRatio > 0 && mediumRatio < 0.35) p += 0.2;
	if (mediumRatio > 0 && mediumRatio < 0.25) p += 0.15;

	const last = words[words.length - 1] ?? "";
	if (/^(ну|вот|да|нет|это)$/u.test(last) && words.length < 28) p += 0.15;

	return Math.min(1, p);
}

/**
 * Information density 0..1 for ranking blend (higher = more thesis-like).
 * Soft penalties reduce score without removing the unit.
 */
export function unitInfoScore(text: string): number {
	const words = tokenizeWords(text);
	if (words.length === 0) return 0;
	const medium = words.filter((w) => w.length >= 4).length;
	const content = words.filter((w) => w.length >= 5 && !FILLER_SINGLE.has(w)).length;
	const mediumRatio = medium / words.length;
	const contentNorm = Math.min(1, content / 15);
	const base = mediumRatio * 0.5 + contentNorm * 0.5;
	return Math.max(0, base * (1 - unitSoftPenalty(text)));
}

/**
 * Hard drop only — used by sanitize (must not empty the whole transcript).
 */
export function isHardDropUnit(text: string): boolean {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return true;
	const lower = s.toLocaleLowerCase();
	const words = tokenizeWords(s);
	if (words.length < 8) return true;

	// Pure greeting / address unit.
	if (GREETING_OPEN_RE.test(s) || /^[\p{L}]+\s+[\p{L}]+\s+хочу\s+/iu.test(s)) {
		return true;
	}
	if (
		/хочу\s+выразить|хочу\s+вам\s+поклон|великое\s+почтение|добрый\s+(?:день|вечер)|здравствуй/iu.test(
			lower,
		)
	) {
		// Only hard-drop if the unit is mostly greeting (not a long Q&A turn).
		if (words.length < 35) return true;
	}

	// Short stage aside only.
	if (/вы\s+слышите/iu.test(lower) && words.length < 18) return true;
	if (/ой-ой-ой|ой\s+ой/iu.test(lower) && words.length < 16) return true;

	const first = words[0] ?? "";
	const contentTokens = words.filter(
		(w) => w.length >= 5 && !FILLER_SINGLE.has(w),
	).length;
	// Mid-phrase opener with almost no content → hard drop.
	if (MID_PHRASE_OPENERS.test(first) && contentTokens < 6) return true;

	// Extreme mush density.
	const medium = words.filter((w) => w.length >= 4).length;
	if (words.length > 0 && medium / words.length < 0.22) return true;
	const shorties = words.filter((w) => w.length <= 2).length;
	if (shorties / words.length > 0.5) return true;

	// Triple+ immediate content repeat.
	if (/(?:^|[\s])([\p{L}]{4,})(?:\s+\1){2,}(?=[\s]|$)/iu.test(s)) return true;

	// YouTube related/watch-next shelf (view counts, "Новинка") — never rank.
	if (
		/\bновинка\b/iu.test(lower) ||
		/\bавтодубляж\b/iu.test(lower) ||
		/\d[\d\s,.]*\s*тыс\.?\s*(?:назад|[гдлм]\.?|дн\.?|мес\.?|л\.?)/iu.test(lower)
	) {
		return true;
	}
	const viewHits = (lower.match(/\d[\d\s,.]*\s*тыс/gu) ?? []).length;
	if (viewHits >= 2) return true;

	return false;
}

/**
 * @deprecated Prefer isHardDropUnit + unitSoftPenalty. Kept as hard-drop alias.
 */
export function isLowQualityUnit(text: string): boolean {
	return isHardDropUnit(text);
}

/**
 * Eligible as a final summary bullet (stricter than pool membership).
 * Mid-phrase crumbs stay in the LexRank graph but must not be emitted.
 * Soft openers like «как», «буквально» remain allowed; bare prepositions / verb cuts are not.
 */
export function isBulletEligible(text: string): boolean {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s || isHardDropUnit(s)) return false;
	if (GREETING_OPEN_RE.test(s)) return false;
	if (
		/хочу\s+выразить|великое\s+почтение|здравствуй/iu.test(s) &&
		tokenizeWords(s).length < 40
	) {
		return false;
	}

	const lower = s.toLocaleLowerCase();
	// Chat / stage digressions — never bullets.
	if (/вы\s+слышите/iu.test(lower)) return false;
	if (/\bслышите\b/iu.test(lower) && tokenizeWords(s).length < 22) return false;
	if (/ой-ой-ой|ой\s+ой/iu.test(lower)) return false;
	// "что вы …" address / digression openers (\b is weak on Cyrillic)
	if (/^что\s+вы(?:\s|$)/iu.test(lower)) return false;
	if (isStructuralMidOpener(s)) return false;

	const words = tokenizeWords(s);
	if (words.length < 10) return false;
	const first = words[0] ?? "";
	// Soft openers stay eligible; hard mid-phrase already blocked above.

	const glue = hasThesisGlue(s);
	const content = words.filter((w) => w.length >= 5 && !FILLER_SINGLE.has(w)).length;
	if (content < 5) return false;

	// Verb-looking opener without real discourse glue → mid-slice caption window.
	if (VERBISH_OPENER_RE.test(first) && !glue) {
		return false;
	}

	const info = unitInfoScore(s);
	// Glue alone is not enough if the line still looks like a mid-phrase cut.
	if (glue && info >= 0.22) return true;
	if (info >= 0.32) return true;
	if (content >= 8 && info >= 0.25) return true;
	return false;
}

/** Strip leading/trailing speech debris from selected bullets. */
export function stripSpeechDebris(text: string): string {
	let s = text.replace(/\s+/g, " ").trim();
	// Leading weak connectors / speech starts / stage crumbs.
	for (let pass = 0; pass < 3; pass += 1) {
		const before = s;
		s = s.replace(
			/^(?:и|а|но|то|ну|вот|эти|потом|же|да|бы|в|за|с|из|у|о|к|от|по|для)\s+/iu,
			"",
		);
		s = s.replace(/^слышите\s+/iu, "");
		if (s === before) break;
	}
	s = s.replace(/\s+вы\s+слышите\.?\s*$/iu, "");
	s = s.replace(/\s+слышите\.?\s*$/iu, "");
	s = s.replace(/\s+/g, " ").trim();
	return s;
}

/**
 * True if the unit looks cut mid-thought (caption boundary), so it should
 * be merged with the following unit before ranking.
 */
export function endsIncomplete(text: string): boolean {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return true;
	if (/[.!?…]$/u.test(s)) return false;
	const words = tokenizeWords(s);
	if (words.length === 0) return true;
	const last = words[words.length - 1] ?? "";
	const penult = words.length >= 2 ? (words[words.length - 2] ?? "") : "";
	// ASR crumbs / short function particles (length ≤ 3).
	if (last.length <= 3) return true;
	// Closed-class only — never topic nouns.
	if (CLOSED_CLASS_LAST_RE.test(last)) return true;
	// Finite / start verb as last token without period → cut mid-clause.
	if (FINITE_VERB_LAST_RE.test(last)) return true;
	// Adjective / participle mid-NP cut (morphology, any domain).
	if (words.length >= 4 && ADJECTIVE_LIKE_LAST_RE.test(last)) {
		return true;
	}
	// Adjective-like penult + short head noun without period (mid-NP).
	if (
		words.length >= 4 &&
		ADJECTIVE_LIKE_LAST_RE.test(penult) &&
		last.length <= 10 &&
		!CLOSED_CLASS_LAST_RE.test(last)
	) {
		return true;
	}
	// Open cut after short connector / "не X" style mid-clause.
	if (
		words.length >= 4 &&
		/^(?:дан|дал|дал[аи]|не|как|что|хотя|очень|совсем)$/u.test(penult) &&
		last.length <= 10
	) {
		return true;
	}
	return false;
}

/**
 * Stronger incomplete-thought check for **summary bullets** (not just ranking merge).
 * Catches mid-clause cuts that still end on a content noun.
 */
export function isIncompleteThought(text: string): boolean {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return true;
	if (isStructuralMidOpener(s) || startsMidPhraseOpener(s)) return true;
	if (endsIncomplete(s)) return true;
	if (/[.!?…]$/u.test(s)) return false;

	const words = tokenizeWords(s);
	if (words.length < 8) return true;
	const first = words[0] ?? "";
	// Verb-looking openers without discourse glue are incomplete mid-slices.
	if (VERBISH_OPENER_RE.test(first) && !hasThesisGlue(s)) return true;
	// Trailing filler / speech crumbs without closure.
	if (
		/(?:^|\s)(?:вот\s+и\s+вот|ну\s+как\s+бы|то\s+есть\s+ну)\s*$/iu.test(s)
	) {
		return true;
	}
	// Ends with dangling "вам" / "нам" after cut mid-address.
	if (/^(вам|нам|мне|тебе|их|его|её|ее)$/u.test(words[words.length - 1] ?? "")) {
		return true;
	}
	// Intensifier + open-class tail without period (e.g. «не очень …», «совсем …»).
	if (
		/(?:^|\s)(?:не\s+)?(?:очень|совсем|более|менее)\s+[\p{L}]{3,}$/iu.test(s)
	) {
		return true;
	}
	// «хотя …» / «как же …» dangling tails (function patterns only).
	if (
		/(?:^|\s)хотя\s+\S{1,16}$/iu.test(s) ||
		/(?:^|\s)как\s+же\s+\S{1,12}$/iu.test(s)
	) {
		return true;
	}
	return false;
}

/**
 * Low-information / generic ASR mush that should not stand as a thesis bullet.
 */
export function isLowInfoBullet(text: string): boolean {
	const s = text.replace(/\s+/g, " ").trim();
	const words = tokenizeWords(s);
	if (words.length < 10) return true;
	const info = unitInfoScore(s);
	if (info < 0.22) return true;
	const lower = s.toLocaleLowerCase();
	// Vague density without concrete structure words.
	const vague =
		/(подробн\w*\s+описыва|очень\s+много|в\s+общем-то|ну\s+как\s+бы|то\s+есть\s+ну)/giu;
	const vagueHits = (lower.match(vague) ?? []).length;
	const content = words.filter((w) => w.length >= 5 && !FILLER_SINGLE.has(w)).length;
	if (vagueHits >= 1 && content < 8) return true;
	if (vagueHits >= 2 && info < 0.35) return true;
	return false;
}

/**
 * Final gate for any engine's summary bullet (extractive or generated).
 */
export function validateSummaryBullet(text: string): boolean {
	const s = text.replace(/\s+/g, " ").trim().replace(/^[-*•]\s+/, "");
	if (s.length < 28) return false;
	if ((s.match(/[\p{L}]/gu) ?? []).length < 18) return false;
	if (!isBulletEligible(s)) return false;
	if (isIncompleteThought(s)) return false;
	if (isLowInfoBullet(s)) return false;
	return true;
}

/**
 * Prefer a complete clause ending; avoid mid-NP hard cuts.
 */
export function truncateAtClauseBoundary(text: string, maxChars: number): string {
	const s = text.replace(/\s+/g, " ").trim();
	if (s.length <= maxChars) return s;
	const slice = s.slice(0, maxChars);
	const clause = slice.match(/^(.+?[.!?…])(?:\s|$)/u);
	if (clause && clause[1].length >= 40) return clause[1].trim();
	// Last space before max — then drop if still incomplete.
	const sp = slice.lastIndexOf(" ");
	const soft = (sp > 40 ? slice.slice(0, sp) : slice).trim();
	if (!isIncompleteThought(soft) && soft.length >= 40) return soft;
	// Try earlier sentence-like break on commas only if long enough head.
	const comma = soft.lastIndexOf(",");
	if (comma > 60) {
		const head = soft.slice(0, comma).trim();
		if (!isIncompleteThought(head)) return head;
	}
	return soft;
}

/** Hard cap for incomplete merges (thesis pairs often exceed 420). */
const MERGE_INCOMPLETE_HARD_CAP = 900;
/** Default soft budget for reverse-merge / incomplete join. */
const MERGE_INCOMPLETE_DEFAULT = 720;

/**
 * Drop a short trailing digression after a generic spoken closer.
 * Closers are fixed discourse formulas used across genres — not topic keywords.
 * Do not add content words from individual video dumps.
 */
export function trimTrailingTopicJump(text: string): string {
	const s = text.replace(/\s+/g, " ").trim();
	if (s.length < 80) return s;

	const closers = [
		/^(.*?это очень важно)\s+(.+)$/iu,
		/^(.*?вот в чём дело)\s+(.+)$/iu,
		/^(.*?вот в чем дело)\s+(.+)$/iu,
	];
	for (const re of closers) {
		const m = s.match(re);
		// Any non-trivial tail after a solid head/closer is digression — drop it.
		if (m && m[1].length >= 40 && m[2].length >= 12) {
			return m[1].trim();
		}
	}
	return s;
}

/**
 * Soft continuation openers (discourse connectors only — no content nouns).
 * Attach to previous when previous ends incomplete.
 */
const CONTINUATION_OPENERS =
	/^(буквально|далее|также|кроме|причём|причем|именно|поэтому|однако|значит|итак|смотрите)$/u;

/**
 * True if the unit opens mid-thought (caption crumb) and should attach to the previous unit.
 */
export function startsMidPhraseOpener(text: string): boolean {
	return isStructuralMidOpener(text);
}

/** True if unit should reverse-merge onto previous (mid-phrase or soft continuation). */
export function startsContinuationOpener(text: string): boolean {
	if (startsMidPhraseOpener(text)) return true;
	const first = tokenizeWords(text)[0] ?? "";
	return CONTINUATION_OPENERS.test(first);
}

/**
 * Attach units that start mid-phrase / soft-continuation to the previous unit.
 */
export function attachMidPhraseOpeners(
	units: string[],
	maxChars = MERGE_INCOMPLETE_DEFAULT,
): string[] {
	if (units.length <= 1) return units;
	const out: string[] = [];
	for (const raw of units) {
		const cur = raw.replace(/\s+/g, " ").trim();
		if (!cur) continue;
		const prev = out.length > 0 ? out[out.length - 1] : "";
		const shouldAttach =
			out.length > 0 &&
			(startsMidPhraseOpener(cur) ||
				(endsIncomplete(prev) && startsContinuationOpener(cur))) &&
			prev.length + 1 + cur.length <= Math.max(maxChars, MERGE_INCOMPLETE_HARD_CAP);
		if (shouldAttach) {
			out[out.length - 1] = `${prev} ${cur}`.replace(/\s+/g, " ");
			continue;
		}
		out.push(cur);
	}
	return out;
}

/**
 * Merge units that end mid-thought with the following unit (caption splits),
 * then reverse-merge mid-phrase / continuation openers onto the previous unit.
 *
 * When prev ends incomplete, always allow at least one append up to the hard cap
 * so thesis pairs (~200+250) are not blocked by a tight soft budget.
 */
export function mergeIncompleteUnits(
	units: string[],
	maxChars = MERGE_INCOMPLETE_DEFAULT,
): string[] {
	if (units.length <= 1) return units;
	const softCap = Math.max(maxChars, MERGE_INCOMPLETE_DEFAULT);
	const hardCap = Math.max(softCap, MERGE_INCOMPLETE_HARD_CAP);
	const out: string[] = [];
	let i = 0;
	while (i < units.length) {
		let cur = units[i].replace(/\s+/g, " ").trim();
		let forcedOnce = false;
		while (i + 1 < units.length && endsIncomplete(cur)) {
			const next = units[i + 1].replace(/\s+/g, " ").trim();
			const combined = cur.length + 1 + next.length;
			// Soft budget for multi-append; hard cap always allows first join.
			const allow =
				combined <= softCap || (!forcedOnce && combined <= hardCap);
			if (!allow) break;
			i += 1;
			forcedOnce = true;
			cur = `${cur} ${next}`.replace(/\s+/g, " ");
		}
		if (cur) out.push(cur);
		i += 1;
	}
	return attachMidPhraseOpeners(out, hardCap);
}

/**
 * Second incomplete-merge pass after mid-phrase attach so newly completable
 * endings can still join the next unit.
 */
export function doubleMergeIncompleteUnits(
	units: string[],
	maxChars = MERGE_INCOMPLETE_DEFAULT,
): string[] {
	const once = mergeIncompleteUnits(units, maxChars);
	return mergeIncompleteUnits(once, maxChars);
}

/**
 * Full clean for one summary unit. Returns null if the unit should be dropped.
 */
export function sanitizeSummaryUnit(text: string): string | null {
	let s = text.replace(/\s+/g, " ").trim();
	if (!s) return null;

	s = collapseAsrLoops(s);
	s = fixAsrGlitches(s);
	s = s.replace(/\s+/g, " ").trim();
	if (s.length < 12) return null;
	if ((s.match(/[\p{L}]/gu) ?? []).length < 8) return null;

	// After glitch clean: drop fragments with fewer than 8 tokens (plan-51).
	const words = tokenizeWords(s);
	if (words.length < 8) return null;

	const scan = scanFillers(s);
	if (scan.contentTokens < 4) return null;

	if (isMostlyFiller(s)) return null;
	if (isPromoOrAdUnit(s)) return null;
	if (endsWithDanglingConnector(s)) return null;
	// Hard drop only — soft chat/mid-phrase penalties apply at ranking time.
	if (isHardDropUnit(s)) return null;

	// Pure stutter residue: very low unique tokens after collapse.
	const unique = new Set(words);
	if (words.length >= 3 && unique.size === 1) return null;

	// Residual stamp digits / duration crumbs that survived earlier scrub.
	if (/\d{1,2}:\d{2}/.test(s)) return null;
	if (/(?:^|\s)(?:секунд[аы]?|минут[аы]?)(?=\s|$)/iu.test(s) && words.length < 10) {
		return null;
	}

	return s;
}

/**
 * Sanitize a list of units and drop consecutive near-duplicates (Jaccard).
 */
export function sanitizeSummaryUnits(units: string[]): string[] {
	const out: string[] = [];
	const outSets: Set<string>[] = [];

	for (const raw of units) {
		const cleaned = sanitizeSummaryUnit(raw);
		if (!cleaned) continue;

		const tokens = tokenSetForDedup(cleaned);
		const prev = out[out.length - 1];
		if (prev && prev.toLocaleLowerCase() === cleaned.toLocaleLowerCase()) {
			continue;
		}
		if (prev) {
			const a = prev.toLocaleLowerCase().slice(0, 48);
			const b = cleaned.toLocaleLowerCase().slice(0, 48);
			if (a.length > 20 && b.length > 20 && (a.includes(b) || b.includes(a))) {
				continue;
			}
		}

		let nearDup = false;
		for (let i = Math.max(0, outSets.length - 4); i < outSets.length; i += 1) {
			if (
				tokens.size >= 3 &&
				jaccardSets(outSets[i], tokens) >= UNIT_JACCARD_DEDUP
			) {
				nearDup = true;
				break;
			}
		}
		if (nearDup) continue;

		out.push(cleaned);
		outSets.push(tokens);
	}

	return out;
}

/** Strip leading/trailing discourse fillers for display. */
export function stripLeadingFillers(text: string): string {
	let s = fixAsrGlitches(text.trim());
	const leading =
		/^(?:ну|вот|типа|типо|короче|короч|значит|блин|вообще|просто|ладно|давайте|погнали|слушай|собственно|да|а|и|но|так)(?:\s*[,–—-]?\s+|\s+)/iu;
	const multiLeading =
		/^(?:в\s+целом|в\s+общем|так\s+сказать|как\s+бы|на\s+самом\s+деле|по\s+ходу|это\s+самое|как-то\s+так|в\s+таком\s+духе|допустим)(?:\s*[,–—-]?\s+|\s+)/iu;

	for (let pass = 0; pass < 4; pass += 1) {
		const before = s;
		s = s.replace(multiLeading, "").replace(leading, "");
		if (s === before) break;
	}
	return s.replace(/\s+/g, " ").trim();
}

/**
 * Rejoin embed/ranking chunks that open mid-phrase or look incomplete so the
 * pool is not full of crumbs that only die at validateSummaryBullet.
 */
export function rejoinInvalidChunks(
	chunks: string[],
	maxChars = MERGE_INCOMPLETE_HARD_CAP,
): string[] {
	if (chunks.length <= 1) return chunks;
	const out: string[] = [];
	for (const raw of chunks) {
		const cur = raw.replace(/\s+/g, " ").trim();
		if (!cur) continue;
		const prev = out.length > 0 ? out[out.length - 1] : "";
		const shouldJoin =
			out.length > 0 &&
			prev.length + 1 + cur.length <= maxChars &&
			(startsMidPhraseOpener(cur) ||
				isIncompleteThought(cur) ||
				endsIncomplete(prev) ||
				startsContinuationOpener(cur));
		if (shouldJoin) {
			out[out.length - 1] = `${prev} ${cur}`.replace(/\s+/g, " ");
			continue;
		}
		out.push(cur);
	}
	return out;
}

/**
 * Split long units for E5 512-token safety (~400 chars trigger).
 * ~300 char chunks with ~10% word-boundary overlap, then rejoin invalid crumbs.
 */
export function splitLongUnitsForEmbed(
	units: string[],
	maxChars = 400,
	chunkChars = 300,
	overlapRatio = 0.1,
): string[] {
	const out: string[] = [];
	const overlapChars =
		overlapRatio > 0 ? Math.max(20, Math.round(chunkChars * overlapRatio)) : 0;

	for (const unit of units) {
		if (unit.length <= maxChars) {
			out.push(unit);
			continue;
		}
		const words = unit.split(/\s+/).filter(Boolean);
		if (words.length === 0) continue;

		let start = 0;
		while (start < words.length) {
			let len = 0;
			let end = start;
			while (end < words.length && len + words[end].length + 1 <= chunkChars) {
				len += words[end].length + 1;
				end += 1;
			}
			if (end === start) {
				out.push(words[start]);
				start += 1;
				continue;
			}
			out.push(words.slice(start, end).join(" "));
			if (end >= words.length) break;
			if (overlapChars === 0) {
				start = end;
				continue;
			}
			// Step forward with overlap.
			let backLen = 0;
			let back = end;
			while (back > start && backLen < overlapChars) {
				back -= 1;
				backLen += words[back].length + 1;
			}
			start = Math.max(start + 1, back);
		}
	}

	return rejoinInvalidChunks(out, Math.max(maxChars * 2, MERGE_INCOMPLETE_HARD_CAP));
}
