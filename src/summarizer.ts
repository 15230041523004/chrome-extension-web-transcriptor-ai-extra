import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { TranscriptionLanguage } from "@/jotai/transcriptionSettings";
import { getActiveBrowserTab } from "@/lib/activeTab";
import {
	createSummaryBackend,
	getAiSummarizationStatus,
	needsTranslation,
	toBcp47Language,
	translateSummaryText,
} from "@/lib/chromeAi";
import { applyMechanicalAsrClean } from "@/lib/asrCleaner";
import { loadCloudAiSettings } from "@/lib/cloudAiSettings";
import {
	buildSummaryScopes,
	formatRankingUnitsDebug,
	isAcceptableGeneratedSummary,
	summarizeLocally,
	summaryBodyChars,
	type BuildScopesOptions,
} from "@/lib/localSummarizer";

const MAX_INPUT_CHARS = 60_000;
const CHUNK_CHARS = 3_800;
const LONG_TEXT_SAMPLE_COUNT = 8;

const SUMMARY_SYSTEM_PROMPT =
	"You are a helpful assistant that summarizes web page content. Your output is markdown formatted. Summarize the main subject with bullet points and meaningful sections. Ignore navigation, advertisements, social links, and calls to action.";

const TRANSCRIPTION_SUMMARY_SYSTEM_PROMPT =
	"You are a helpful assistant that summarizes audio transcriptions. Your output is markdown formatted. Highlight key points, decisions, and action items. If speakers are labeled (e.g. Speaker 1, Speaker 2), note who said what when relevant.";

const VIDEO_TRANSCRIPT_SUMMARY_SYSTEM_PROMPT =
	"You are a helpful assistant that summarizes YouTube video transcripts and captions. Your output is markdown formatted. Highlight the main topics, key points, decisions, and action items from the spoken content.";

/** Step 1: fact cleaning (not a summary). Prefer LanguageModel. */
const FACT_CLEAN_SYSTEM =
	"You clean lecture and speech transcripts. You only remove noise. You never invent facts. Keep chronological order. Return plain text only.";

const FACT_CLEAN_USER_RU =
	"Убери из текста повторы слов, разговорные вставки, шутки и самокомментарии лектора вроде «давайте напишем», «вот», «ну». Можно оставить заявленные цели обучения (в т.ч. подготовку к экзамену), но убери pep-talk и болтовню. Оставь факты: события, даты, термины, имена, план тем. Не добавляй факты, которых нет в тексте. Верни чистый текст.\n\nТекст:\n";

const FACT_CLEAN_USER_EN =
	"Remove word repeats, colloquial fillers, jokes, and lecturer asides such as “let’s write that down”, “well”, “so”. You may keep stated learning goals (including exam prep framing) but drop pep-talk. Keep only facts: events, dates, terms, names, topic plan. Do not add facts that are not in the text. Return plain cleaned text.\n\nText:\n";

/** Step 2: structure cleaned facts into short bullets. */
const OUTLINE_SYSTEM =
	"You turn cleaned factual lecture notes into a structured outline for ONE fragment only. Do not invent eras, dates, or topics absent from the input. Prefer concrete theses over vague abstracts. Do not add exam advice filler.";

const OUTLINE_USER_RU =
	"Сделай подробные заметки **только по этому фрагменту** объёмом примерно 10% от длины входного текста (не ультра-краткий пересказ). Несколько конкретных тезисов: кто/что сказал, какой аргумент, какой вывод. Не выдумывай факты, имена и сравнения, которых нет во входе. Без вводных слов. Формат: markdown-список (- …).\n\nТекст:\n";

const OUTLINE_USER_EN =
	"Write detailed notes **only for this fragment**, about 10% of the input length (not an ultra-short blurb). Several concrete theses: who/what, argument, conclusion. Do not invent facts, names, or comparisons absent from the input. No fluff. Format: markdown list (- …).\n\nText:\n";

const TWO_PASS_CHUNK_CHARS = 3_500;

type YouTubeExtractDebug = {
	videoId: string | null;
	hasPlayerResponse: boolean;
	trackCount: number;
	domRootCount: number;
	domLineCount: number;
	source: string | null;
	lastError: string | null;
};

type YouTubePageContent = {
	text: string;
	kind: "transcript" | "metadata" | "empty";
	title?: string;
	debug?: YouTubeExtractDebug;
};

function trimTextForSummary(text: string, maxChars = MAX_INPUT_CHARS): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}

	// Chronological windows only (no body-scatter that breaks Part/episode order).
	const windowCount = Math.min(LONG_TEXT_SAMPLE_COUNT, 8);
	const windowSize = Math.floor(maxChars / windowCount);
	const maxStart = Math.max(0, trimmed.length - windowSize);
	const parts: string[] = [];
	for (let i = 0; i < windowCount; i += 1) {
		const start =
			windowCount === 1
				? 0
				: Math.round((maxStart * i) / (windowCount - 1));
		parts.push(trimmed.slice(start, start + windowSize).trim());
	}
	return parts.filter(Boolean).join("\n\n");
}

const SECTION_HEADER_RE =
	/^(?:эпизод|часть|глава|раздел|episode|part|chapter|section)\s*\d+\b/iu;

/** True if line is a structural section title (kept as markdown header later). */
export function isTranscriptSectionHeader(line: string): boolean {
	const t = line.trim();
	if (!t) return false;
	if (SECTION_HEADER_RE.test(t)) return true;
	// "Эпизод 1: вступление"
	if (/^(?:эпизод|часть|глава|episode|part|chapter)\s*\d+\s*[:.\-–—]/iu.test(t)) {
		return true;
	}
	return false;
}

/** Line that is only a clock timestamp (Format A). */
function isPureTimestampLine(line: string): boolean {
	return /^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?$/u.test(line.trim());
}

/**
 * Full-string multi-pass scrub of clocks and spoken durations (anywhere, including glued).
 * Must run **before** sentence splitting so "0:33 секундыНачало" does not poison units.
 */
export function scrubAllTimecodes(text: string): string {
	let s = text.replace(/\u200b/g, "");
	if (!s.trim()) return "";
	if (isPureTimestampLine(s)) return "";

	for (let pass = 0; pass < 6; pass += 1) {
		const before = s;

		// Digital clocks anywhere (optionally glued to following letters): 0:33, 0:00:05, 0:000
		s = s.replace(/(?:(?:\d{1,2}:){1,2}\d{2,3}(?:\.\d+)?)/g, " ");

		// Start-anchored RU a11y styles
		s = s.replace(
			/(?:^|[\s])(?:минут[аы]?|мин\.?)\s*\d{1,3}\s*(?:секунд[аы]?|сек\.?)?/giu,
			" ",
		);
		// Never use bare "ч" — it eats the letter from "что". Only "час(а/ов)" or "ч."
		s = s.replace(
			/(?:^|[\s])(?:час(?:а|ов)?|ч\.)\s*\d{0,3}\s*(?:минут[аы]?|мин\.?)?\s*\d{0,3}\s*(?:секунд[аы]?|сек\.?)?/giu,
			" ",
		);

		// "N секунд/минут/час" mid-string (avoid \b — weak on Cyrillic in JS)
		s = s.replace(
			/(?:^|[\s])\d{1,3}\s*(?:час(?:а|ов)?|минуты|минута|минут|секунды|секунда|секунд|мин\.?|сек\.?)(?=[\s.,!?]|$)/giu,
			" ",
		);
		s = s.replace(
			/(?:^|[\s])(?:минуты|минута|минут|секунды|секунда|секунд|мин\.?|сек\.?)\s*\d{1,3}(?=[\s.,!?]|$)/giu,
			" ",
		);

		// Bare duration stem glued to next word: "секундыНачало", "секундпривет".
		// Longer forms first so "минуты" is not peeled into "минут"+"ы".
		s = s.replace(
			/(?:секунды|секунда|секунд|минуты|минута|минут|сек\.?|мин\.?)(?=\p{L})/giu,
			" ",
		);
		// Remaining bare "секунд(ы)" stamp tokens (not glued content words)
		s = s.replace(
			/(?:^|[\s])(?:секунды|секунда|секунд|сек\.?)(?:\s*\d{0,3})?(?=[\s.,!?]|$)/giu,
			" ",
		);

		// Digit glued to letters only at line start: "0которая" (not mid-line).
		s = s.replace(/^\d{1,4}(?=\p{L})/u, "");

		// Orphan short pure-digit tokens left from stamps (not letters after).
		s = s.replace(/(?:^|[\s])\d{1,3}(?=[\s.,!?]|$)/g, " ");

		// Stage / non-speech brackets and bare RU cues
		s = s.replace(
			/\[(?:аплодисменты|смех|музыка|шум|неразборчиво|applause|laughter|music|crosstalk|inaudible|unk)\]|\((?:аплодисменты|смех|музыка|applause|laughter|music)\)/giu,
			" ",
		);
		s = s.replace(/(?:аплодисменты|смех|музыка|applause|laughter)(?=\p{L})/giu, " ");

		// Only strip punctuation/clock residue — never strip leading Cyrillic letters.
		s = s.replace(/^[:\-–—•.,;\s]+/u, "");
		s = s.replace(/\s+/g, " ").trim();
		if (s === before) break;
	}
	return s;
}

/**
 * Aggressive ASR/YouTube timecode scrub for one line (Format B glued stamps).
 * Handles: "0:00 text", "0:33 секундыНачало", "Минут 28 секундкоторая…".
 */
export function cleanASRTimecodesLine(line: string): string {
	return scrubAllTimecodes(line);
}

/**
 * Opening / greeting patterns — if they cluster at the end of the list, cues are reversed.
 */
const TRANSCRIPT_OPENING_RE =
	/(?:^|[\s,.])(?:приветствую|здравствуй(?:те)?|добрый\s+(?:день|вечер)|хочу\s+выразить|хочу\s+вам\s+поклон|поклон(?:юсь|иться)|от\s+имени\s+всех|разрешите\s+начать|начн[её]м\s+с)/iu;

/**
 * YouTube related/watch-next shelf noise (view counts, "New", channel glue).
 * Not speech — must never enter Stage 1 / ranking.
 */
export function isYoutubeShelfNoiseLine(text: string): boolean {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s || s.length < 12) return false;
	const lower = s.toLocaleLowerCase();

	// Strong single-signal shelf markers (RU + EN UI).
	if (
		/\bновинка\b/iu.test(lower) ||
		/\bавтодубляж\b/iu.test(lower) ||
		/\bnew\s*·/iu.test(lower) ||
		/\bnexta\b/iu.test(lower)
	) {
		return true;
	}
	// "373 тыс. назад" / "6,8 тыс назад" / "245 тыс. л. назад"
	if (
		/\d[\d\s,.]*\s*тыс\.?\s*(?:назад|[гдлм]\.?|дн\.?|мес\.?|л\.?)/iu.test(
			lower,
		)
	) {
		return true;
	}
	if (/\d[\d\s,.]*\s*(?:k|m)\s+views?\b/iu.test(lower)) return true;
	if (/\b\d+\s*(?:hours?|days?|weeks?|months?|years?)\s+ago\b/iu.test(lower)) {
		return true;
	}

	// Glued multi-title shelf blob: several view-count hits or " / " title chains + counts.
	const viewHits = (lower.match(/\d[\d\s,.]*\s*тыс/gu) ?? []).length;
	const slashTitles = (s.match(/\s\/\s/g) ?? []).length;
	if (viewHits >= 2) return true;
	if (viewHits >= 1 && slashTitles >= 2 && s.length > 80) return true;
	// Long glued blob with no sentence punctuation but many capital runs (card titles).
	if (
		s.length > 200 &&
		viewHits >= 1 &&
		!/[.!?…]/.test(s) &&
		(s.match(/[А-ЯЁA-Z][\p{L}]{3,}/gu) ?? []).length >= 6
	) {
		return true;
	}
	return false;
}

/** 0..1 fraction of shelf noise in text (by line / head weight). */
export function youtubeShelfNoiseDensity(text: string): number {
	const t = text.replace(/\s+/g, " ").trim();
	if (!t) return 0;
	if (isYoutubeShelfNoiseLine(t)) return 1;
	const lines = text
		.split(/\n+/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return 0;
	let bad = 0;
	let weight = 0;
	for (let i = 0; i < lines.length; i += 1) {
		const w = i < 5 ? 2 : 1; // head lines matter more
		weight += w;
		if (isYoutubeShelfNoiseLine(lines[i])) bad += w;
	}
	// Also scan head blob (glued shelf without newlines).
	const head = t.slice(0, Math.min(600, t.length));
	if (isYoutubeShelfNoiseLine(head) && lines.length <= 3) return 1;
	return Math.min(1, bad / Math.max(weight, 1));
}

/** Pull speech tail out of a line that starts as shelf glue. */
function extractSpeechAfterShelf(line: string): string | null {
	const openMatch = line.match(
		/(?:^|[\s])((?:лексей|алексей|как\s+бы|хочу\s+выразить|здравствуй|добрый\s+(?:день|вечер)|приветствую).+)$/iu,
	);
	if (!openMatch || openMatch.index === undefined) return null;
	const head = line.slice(0, openMatch.index).trim();
	// Only split when the prefix looks like recommendation shelf.
	if (head.length >= 20 && isYoutubeShelfNoiseLine(head)) {
		return openMatch[1].trim();
	}
	// Whole line is shelf-classified but contains a clear speech opener mid-string.
	if (isYoutubeShelfNoiseLine(line) && openMatch.index > 20) {
		return openMatch[1].trim();
	}
	return null;
}

/**
 * Drop leading recommendation-shelf block before the first speech opener.
 */
export function stripLeadingYoutubeShelf(text: string): string {
	const lines = text
		.replace(/\r\n/g, "\n")
		.split(/\n+/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return "";

	// Rewrite shelf+speech glued lines before dropping pure shelf lines.
	const rewritten = lines.map((line) => {
		const extracted = extractSpeechAfterShelf(line);
		return extracted ?? line;
	});

	let start = 0;
	while (start < rewritten.length && isYoutubeShelfNoiseLine(rewritten[start])) {
		// Keep if this line was already rewritten to pure speech.
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

	// If still no opener, skip until speech opener.
	if (start < rewritten.length && !TRANSCRIPT_OPENING_RE.test(rewritten[start])) {
		for (let i = start; i < Math.min(rewritten.length, start + 12); i += 1) {
			if (TRANSCRIPT_OPENING_RE.test(rewritten[i])) {
				start = i;
				break;
			}
			if (
				/хочу\s+выразить|хочу\s+вам\s+поклон|как\s+бы\s+я\s+шёл|как\s+бы\s+я\s+шел/iu.test(
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

/**
 * If openings appear only in the last chunk of lines, reverse to restore chrono order.
 * Virtualized YouTube DOM often yields bottom→top cue lists when times fail to parse.
 */
export function ensureChronologicalLines(lines: string[]): string[] {
	if (lines.length < 6) return lines;
	const n = lines.length;
	const headN = Math.min(10, Math.max(3, Math.floor(n * 0.15)));
	const tailN = headN;
	const head = lines.slice(0, headN).join(" ");
	const tail = lines.slice(n - tailN).join(" ");
	const headOpen = TRANSCRIPT_OPENING_RE.test(head);
	const tailOpen = TRANSCRIPT_OPENING_RE.test(tail);
	if (tailOpen && !headOpen) {
		return [...lines].reverse();
	}
	return lines;
}

/**
 * Full ASR clean: scrub timestamps, restore chrono order, keep **one cue per line**
 * (so Stage 3 can unitize by lines instead of soft-shredding glued prose).
 * Episode headers remain scope anchors.
 * Also drops YouTube recommendation-shelf noise.
 */
export function cleanYouTubeTranscriptText(raw: string): string {
	const chromeOnly =
		/^(показать текст видео|поиск в расшифровке|show transcript|search in transcript|в этом видео)$/iu;

	// Strip glued shelf prefix before line split when whole blob is one line.
	const pre = stripLeadingYoutubeShelf(raw.replace(/\r\n/g, "\n"));

	type Block = { title: string; parts: string[] };
	const blocks: Block[] = [];
	let title = "";
	let parts: string[] = [];

	const flush = () => {
		if (title || parts.length > 0) {
			blocks.push({ title, parts });
		}
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

	const out: string[] = [];
	for (const block of blocks) {
		// Chrono fix per block (DOM reverse).
		const ordered = ensureChronologicalLines(block.parts);
		const cleanedLines = ordered
			.map((p) => scrubAllTimecodes(p).replace(/\s+/g, " ").trim())
			.filter((p) => Boolean(p) && !isYoutubeShelfNoiseLine(p));
		// Drop leading shelf residual again after chrono.
		const stripped = stripLeadingYoutubeShelf(cleanedLines.join("\n"))
			.split(/\n+/)
			.map((l) => l.trim())
			.filter(Boolean);
		const body = stripped.join("\n");
		if (block.title && body) {
			out.push(`${block.title}\n${body}`);
		} else if (block.title) {
			out.push(block.title);
		} else if (body) {
			out.push(body);
		}
	}

	return out.join("\n\n");
}

function splitLongBlock(block: string, chunkSize: number): string[] {
	const chunks: string[] = [];
	let remaining = block.trim();

	while (remaining.length > chunkSize) {
		const candidate = remaining.slice(0, chunkSize + 1);
		const boundaries = [
			candidate.lastIndexOf("\n"),
			candidate.lastIndexOf(". "),
			candidate.lastIndexOf("! "),
			candidate.lastIndexOf("? "),
			candidate.lastIndexOf(" "),
		];
		const naturalBoundary = Math.max(...boundaries);
		const splitAt = naturalBoundary >= chunkSize * 0.55 ? naturalBoundary + 1 : chunkSize;
		chunks.push(remaining.slice(0, splitAt).trim());
		remaining = remaining.slice(splitAt).trim();
	}

	if (remaining) chunks.push(remaining);
	return chunks;
}

function splitIntoChunks(text: string, chunkSize = CHUNK_CHARS): string[] {
	if (text.length <= chunkSize) {
		return [text];
	}

	const blocks = text
		.split(/\n{2,}/)
		.flatMap((paragraph) => splitLongBlock(paragraph, chunkSize));
	const chunks: string[] = [];
	let current = "";

	for (const block of blocks) {
		const next = current ? `${current}\n\n${block}` : block;
		if (next.length > chunkSize && current) {
			chunks.push(current);
			current = block;
		} else {
			current = next;
		}
	}

	if (current) chunks.push(current);
	return chunks;
}

async function summarizeText(
	text: string,
	options: {
		language: TranscriptionLanguage;
		systemPrompt: string;
		title?: string;
	},
): Promise<string> {
	const normalized = trimTextForSummary(text);
	if (!normalized) {
		throw new Error("No text to summarize");
	}

	const chunks = splitIntoChunks(normalized);
	const session = await createSummaryBackend(options.systemPrompt, options.language);

	try {
		const chunkSummaries: string[] = [];
		for (const [index, chunk] of chunks.entries()) {
			const partLabel = chunks.length > 1 ? ` (part ${index + 1} of ${chunks.length})` : "";
			const summary = await session.summarize(
				`Summarize the following text${partLabel}:\n\n${chunk}`,
			);
			chunkSummaries.push(summary);
		}

		let summary =
			chunkSummaries.length === 1
				? chunkSummaries[0]
				: await session.summarize(
						`Combine the following partial summaries into one cohesive markdown summary:\n\n${chunkSummaries.join("\n\n---\n\n")}`,
					);

		if (needsTranslation(session.backend, options.language)) {
			summary = await translateSummaryText(summary, options.language);
		}

		if (options.title) {
			return `${options.title}\n\n${summary}`;
		}

		return summary;
	} finally {
		session.destroy();
	}
}

function isRussianSummaryLanguage(language: TranscriptionLanguage): boolean {
	return language === "russian" || language.startsWith("russian");
}

function normalizeOutlineMarkdown(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;
	if (/^[-*•]/m.test(trimmed) || trimmed.includes("\n-")) {
		return trimmed
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) =>
				/^[-*•]\s*/.test(line) ? line.replace(/^[-*•]\s*/, "- ") : `- ${line}`,
			)
			.join("\n");
	}
	// Numbered lines → bullets
	const numbered = trimmed
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.replace(/^\d+[.)]\s*/, "- "));
	if (numbered.length >= 3) return numbered.join("\n");
	return trimmed;
}

const POLISH_SYSTEM =
	"You polish extractive lecture notes into a markdown bullet list. Use only facts from the input. Do not invent topics, dates, or claims. Do not shorten aggressively — preserve distinct facts. Fix obvious ASR typos only when context is clear.";

/**
 * Optional browser-AI polish of already-selected extractive bullets (Phase A4).
 * Returns null if browser AI is unavailable or polish fails.
 */
export async function polishExtractiveNotes(
	bulletsMarkdown: string,
	language: TranscriptionLanguage,
	title = "",
): Promise<string | null> {
	const status = await getAiSummarizationStatus();
	if (!status.browserAiAvailable) return null;

	const source = bulletsMarkdown.trim();
	if (source.length < 40) return null;

	const useRu = isRussianSummaryLanguage(language);
	const user = useRu
		? `Заголовок видео: ${title || "(без названия)"}\n\nОтполируй эти пункты: исправь очевидные ASR-ошибки если ясно из контекста, слегка выровняй формулировки. Сохрани все различные факты и примерно тот же объём (не сжимай до 3 коротких абстрактных строк). Не добавляй новых утверждений. Формат: markdown-список (- …).\n\nПункты:\n${source}`
		: `Video title: ${title || "(none)"}\n\nPolish these points: fix obvious ASR typos if clear from context, lightly clean wording. Keep all distinct facts and roughly the same length (do not compress to 3 short abstract lines). Do not add new claims. Format: markdown list (- …).\n\nPoints:\n${source}`;

	let session: Awaited<ReturnType<typeof createSummaryBackend>> | null = null;
	try {
		try {
			session = await createSummaryBackend(POLISH_SYSTEM, language, "languageModel");
		} catch {
			session = await createSummaryBackend(POLISH_SYSTEM, language);
		}
		if (session.backend === "local") {
			session.destroy();
			return null;
		}
		const polished = (await session.summarize(user)).trim();
		session.destroy();
		session = null;
		if (!polished || polished.length < 20) return null;
		return normalizeOutlineMarkdown(polished);
	} catch (error) {
		console.warn("[PolishAI] Extractive polish failed:", error);
		try {
			session?.destroy();
		} catch {
			// ignore
		}
		return null;
	}
}

/**
 * Polish extractive notes via browser AI only (Gemini Nano / Chrome LanguageModel).
 * Online cloud services (xAI / SpaceXAI / etc.) are not used — offline extractive remains the fallback.
 */
export async function polishExtractiveNotesWithFallback(
	bulletsMarkdown: string,
	language: TranscriptionLanguage,
	title = "",
): Promise<string | null> {
	return polishExtractiveNotes(bulletsMarkdown, language, title);
}

/**
 * Two-pass browser AI (LanguageModel preferred), **per scope**:
 * 1) Clean ASR/lecture noise → facts only (inside one episode / start segment)
 * 2) Structure into 4–8 short fact bullets for that scope only
 * Returns null if browser AI is unavailable (caller should use local path).
 */
export async function summarizeTranscriptTwoPass(
	text: string,
	language: TranscriptionLanguage,
	scopeOptions: BuildScopesOptions = {},
): Promise<string | null> {
	const status = await getAiSummarizationStatus();
	if (!status.browserAiAvailable) {
		return null;
	}

	const useRu = isRussianSummaryLanguage(language);
	const cleanInstruction = useRu ? FACT_CLEAN_USER_RU : FACT_CLEAN_USER_EN;
	const outlineInstruction = useRu ? OUTLINE_USER_RU : OUTLINE_USER_EN;

	// Prefer LanguageModel for two different instructions; allow summarizer/legacy fallback.
	let cleaner: Awaited<ReturnType<typeof createSummaryBackend>> | null = null;
	let outliner: Awaited<ReturnType<typeof createSummaryBackend>> | null = null;

	try {
		const source = text.trim();
		if (!source) return null;

		const scopes = buildSummaryScopes(source, scopeOptions);
		if (scopes.length === 0) return null;

		try {
			cleaner = await createSummaryBackend(
				FACT_CLEAN_SYSTEM,
				language,
				"languageModel",
			);
		} catch {
			cleaner = await createSummaryBackend(FACT_CLEAN_SYSTEM, language);
		}
		if (cleaner.backend === "local") {
			cleaner.destroy();
			return null;
		}

		try {
			outliner = await createSummaryBackend(
				OUTLINE_SYSTEM,
				language,
				"languageModel",
			);
		} catch {
			outliner = await createSummaryBackend(OUTLINE_SYSTEM, language);
		}

		const outlineBlocks: string[] = [];

		for (const scope of scopes) {
			const scopeText = (scope.text || scope.units.join(" ")).trim();
			if (scopeText.length < 20) continue;

			// Step 1: clean facts only inside this scope
			const chunks = splitIntoChunks(scopeText, TWO_PASS_CHUNK_CHARS);
			const cleanedParts: string[] = [];
			for (const [index, chunk] of chunks.entries()) {
				const partNote =
					chunks.length > 1 ? ` (part ${index + 1}/${chunks.length})` : "";
				const scopeNote = scope.title ? ` [fragment: ${scope.title}]` : "";
				const cleaned = (
					await cleaner.summarize(
						`${cleanInstruction}${scopeNote}${partNote}\n${chunk}`,
					)
				).trim();
				if (cleaned) cleanedParts.push(cleaned);
			}

			const cleanedFacts = cleanedParts.join("\n\n").trim();
			if (cleanedFacts.length < 20) continue;

			if (outliner.backend === "local") {
				if (scope.title) outlineBlocks.push(`## ${scope.title}`);
				outlineBlocks.push(cleanedFacts);
				continue;
			}

			// Step 2: outline for this fragment only
			const outlineInput =
				cleanedFacts.length > TWO_PASS_CHUNK_CHARS * 2
					? cleanedFacts.slice(0, TWO_PASS_CHUNK_CHARS * 2)
					: cleanedFacts;
			const scopeHeader = scope.title
				? `Fragment title: ${scope.title}\n\n`
				: "";
			const outline = (
				await outliner.summarize(
					`${outlineInstruction}${scopeHeader}${outlineInput}`,
				)
			).trim();

			if (scope.title) outlineBlocks.push(`## ${scope.title}`);
			if (outline) {
				outlineBlocks.push(normalizeOutlineMarkdown(outline));
			} else {
				outlineBlocks.push(cleanedFacts);
			}
		}

		cleaner.destroy();
		cleaner = null;
		outliner.destroy();
		outliner = null;

		if (outlineBlocks.length === 0) return null;
		return outlineBlocks.join("\n\n");
	} catch (error) {
		console.warn("[TwoPassAI] Browser two-pass notes failed:", error);
		try {
			cleaner?.destroy();
		} catch {
			// ignore
		}
		try {
			outliner?.destroy();
		} catch {
			// ignore
		}
		return null;
	}
}

export async function summarizeTranscription(
	transcription: string,
	language: TranscriptionLanguage,
): Promise<string> {
	const text = transcription.trim();
	if (!text) {
		throw new Error("Transcription is empty. Record or paste text first.");
	}

	const twoPass = await summarizeTranscriptTwoPass(text, language);
	if (twoPass) {
		return `# Transcription Summary\n\n${twoPass}`;
	}

	return summarizeText(text, {
		language,
		systemPrompt: TRANSCRIPTION_SUMMARY_SYSTEM_PROMPT,
		title: "# Transcription Summary",
	});
}

/** True for youtube.com / youtu.be hosts (including m., music., www., nocookie). */
export function isYouTubeWatchUrl(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const host = new URL(url).hostname.toLocaleLowerCase().replace(/^www\./, "");
		return (
			host === "youtube.com" ||
			host.endsWith(".youtube.com") ||
			host === "youtu.be" ||
			host === "youtube-nocookie.com" ||
			host.endsWith(".youtube-nocookie.com")
		);
	} catch {
		return /youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(url);
	}
}

/** True only for a concrete video page (watch / shorts / live / embed), not home/search. */
export function isYouTubeVideoPageUrl(url: string | undefined): boolean {
	if (!isYouTubeWatchUrl(url) || !url) return false;
	try {
		const parsed = new URL(url);
		if (parsed.searchParams.get("v")) return true;
		return /\/(?:watch|shorts|live|embed)\b/i.test(parsed.pathname);
	} catch {
		return /[?&]v=|\/(?:watch|shorts|live|embed)\//i.test(url);
	}
}

async function extractYouTubePageContent(
	tabId: number,
	preferredLanguageCode: string | null,
): Promise<YouTubePageContent> {
	let injection: chrome.scripting.InjectionResult<YouTubePageContent>[];
	try {
		// Prefer MAIN world (ytInitialPlayerResponse). Fall back to isolated if MAIN fails.
		try {
			injection = await chrome.scripting.executeScript({
				target: { tabId },
				world: "MAIN",
				args: [preferredLanguageCode],
				func: extractYouTubeInPage,
			});
		} catch (mainErr) {
			console.warn("[YouTubeTranscript] MAIN world inject failed, retry isolated:", mainErr);
			injection = await chrome.scripting.executeScript({
				target: { tabId },
				world: "ISOLATED",
				args: [preferredLanguageCode],
				func: extractYouTubeInPage,
			});
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			text: "",
			kind: "empty",
			debug: {
				videoId: null,
				hasPlayerResponse: false,
				trackCount: 0,
				domRootCount: 0,
				domLineCount: 0,
				source: null,
				lastError: `executeScript failed: ${message}`,
			},
		};
	}

	const result = injection?.[0]?.result;
	if (result) return result;

	return {
		text: "",
		kind: "empty",
		debug: {
			videoId: null,
			hasPlayerResponse: false,
			trackCount: 0,
			domRootCount: 0,
			domLineCount: 0,
			source: null,
			lastError:
				injection?.[0] == null
					? "executeScript returned empty frame result (tab may be restricted or not ready)"
					: "executeScript returned no result",
		},
	};
}

/**
 * Injected into the YouTube tab. Must be self-contained (no outer module closures).
 */
async function extractYouTubeInPage(
	preferredLang: string | null,
): Promise<YouTubePageContent> {
			type CaptionTrack = {
				baseUrl?: string;
				languageCode?: string;
				kind?: string;
				vssId?: string;
			};
			type PlayerResponse = {
				videoDetails?: {
					videoId?: string;
					title?: string;
					shortDescription?: string;
				};
				captions?: {
					playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
				};
			};
			type CaptionResponse = {
				events?: Array<{ segs?: Array<{ utf8?: string }> }>;
			};
			type Ytcfg = {
				data_?: Record<string, unknown>;
				get?: (key: string) => unknown;
			};
			type YouTubeWindow = Window & {
				ytInitialPlayerResponse?: PlayerResponse;
				ytInitialData?: unknown;
				ytcfg?: Ytcfg;
				ytplayer?: { config?: { args?: { player_response?: string } } };
			};

			const MIN_TRANSCRIPT_CHARS = 40;
			const pageWindow = window as YouTubeWindow;
			const preferred = preferredLang?.toLocaleLowerCase() ?? null;
			const debug: {
				videoId: string | null;
				hasPlayerResponse: boolean;
				trackCount: number;
				domRootCount: number;
				domLineCount: number;
				source: string | null;
				lastError: string | null;
			} = {
				videoId: null,
				hasPlayerResponse: false,
				trackCount: 0,
				domRootCount: 0,
				domLineCount: 0,
				source: null,
				lastError: null,
			};

			const normalizeText = (value: string): string =>
				value
					.replace(/\u200b/g, "")
					.replace(/[ \t]+/g, " ")
					.replace(/\n{2,}/g, "\n")
					.trim();

			const stripSpokenDuration = (value: string): string =>
				normalizeText(value)
					.replace(
						/\d+\s*(?:час(?:а|ов)?|ч\.?)\s*(?:\d+\s*(?:минут[аы]?|мин\.?)\s*)?(?:\d+\s*(?:секунд[аы]?|сек\.?)?)?/giu,
						" ",
					)
					.replace(/\b\d+\s*(?:секунд[аы]?|сек\.?)\b/giu, " ")
					.replace(/\s+/g, " ")
					.trim();

			const stripLeadingTimestamp = (value: string): string =>
				stripSpokenDuration(
					normalizeText(value).replace(
						/^(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?\s+/,
						"",
					),
				);

			const parseCueSeconds = (raw: string): number | null => {
				const match = raw.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
				if (!match) return null;
				const hours = match[1] ? Number(match[1]) : 0;
				const minutes = Number(match[2]);
				const seconds = Number(match[3]);
				if (
					!Number.isFinite(hours) ||
					!Number.isFinite(minutes) ||
					!Number.isFinite(seconds)
				) {
					return null;
				}
				return hours * 3600 + minutes * 60 + seconds;
			};

			const getVideoId = (): string | null => {
				try {
					const fromUrl = new URL(location.href).searchParams.get("v");
					if (fromUrl) return fromUrl;
				} catch {
					// Ignore.
				}
				const short = location.pathname.match(
					/\/(?:shorts|live|embed)\/([^/?#]+)/,
				);
				return short?.[1] ?? null;
			};

			const parseJsonObjectAfterMarker = (
				source: string,
				marker: string,
			): unknown => {
				const idx = source.indexOf(marker);
				if (idx < 0) return null;
				const eq = source.indexOf("=", idx);
				if (eq < 0) return null;
				let depth = 0;
				let start = -1;
				for (let i = eq; i < source.length; i += 1) {
					const ch = source[i];
					if (ch === "{") {
						if (start < 0) start = i;
						depth += 1;
					} else if (ch === "}") {
						depth -= 1;
						if (depth === 0 && start >= 0) {
							try {
								return JSON.parse(source.slice(start, i + 1));
							} catch {
								return null;
							}
						}
					}
				}
				return null;
			};

			const getPlayerResponse = (): PlayerResponse | null => {
				const moviePlayer = document.querySelector("#movie_player") as
					| (HTMLElement & { getPlayerResponse?: () => PlayerResponse })
					| null;
				try {
					const live = moviePlayer?.getPlayerResponse?.();
					if (live?.videoDetails || live?.captions) return live;
				} catch {
					// Player API can throw mid-navigation.
				}

				if (pageWindow.ytInitialPlayerResponse) {
					return pageWindow.ytInitialPlayerResponse;
				}

				try {
					const raw = pageWindow.ytplayer?.config?.args?.player_response;
					if (raw) return JSON.parse(raw) as PlayerResponse;
				} catch {
					// Ignore.
				}

				for (const script of document.querySelectorAll("script")) {
					const text = script.textContent ?? "";
					if (!text.includes("ytInitialPlayerResponse")) continue;
					const parsed = parseJsonObjectAfterMarker(
						text,
						"ytInitialPlayerResponse",
					) as PlayerResponse | null;
					if (parsed) return parsed;
				}
				return null;
			};

			const ytcfgGet = (key: string): unknown => {
				try {
					if (typeof pageWindow.ytcfg?.get === "function") {
						return pageWindow.ytcfg.get(key);
					}
				} catch {
					// Ignore.
				}
				return pageWindow.ytcfg?.data_?.[key];
			};

			const playerResponse = getPlayerResponse();
			debug.hasPlayerResponse = Boolean(playerResponse);
			const title = playerResponse?.videoDetails?.title;
			const videoId = playerResponse?.videoDetails?.videoId ?? getVideoId();
			debug.videoId = videoId;

			const trackLang = (track: CaptionTrack): string =>
				(track.languageCode ?? "").toLocaleLowerCase();

			const matchesPreferred = (track: CaptionTrack): boolean => {
				if (!preferred) return false;
				const code = trackLang(track);
				const vss = (track.vssId ?? "").toLocaleLowerCase();
				return (
					code === preferred ||
					code.startsWith(`${preferred}-`) ||
					vss === `.${preferred}` ||
					vss === `a.${preferred}` ||
					vss.endsWith(`.${preferred}`)
				);
			};

			const pickCaptionTracks = (tracks: CaptionTrack[]): CaptionTrack[] => {
				if (tracks.length === 0) return [];
				const preferredHuman = tracks.filter(
					(track) => matchesPreferred(track) && track.kind !== "asr",
				);
				const preferredAny = tracks.filter((track) => matchesPreferred(track));
				const human = tracks.filter((track) => track.kind !== "asr");
				const ordered = [
					...preferredHuman,
					...preferredAny,
					...human,
					...tracks,
				];
				const seen = new Set<CaptionTrack>();
				return ordered.filter((track) => {
					if (seen.has(track)) return false;
					seen.add(track);
					return true;
				});
			};

			const decodeXmlEntities = (value: string): string =>
				value
					.replace(/&amp;/g, "&")
					.replace(/&lt;/g, "<")
					.replace(/&gt;/g, ">")
					.replace(/&quot;/g, '"')
					.replace(/&#39;/g, "'")
					.replace(/&nbsp;/g, " ")
					.replace(/&#(\d+);/g, (_, n) =>
						String.fromCodePoint(Number(n) || 32),
					)
					.replace(/&#x([0-9a-f]+);/gi, (_, h) =>
						String.fromCodePoint(Number.parseInt(h, 16) || 32),
					);

			/** Append query param without rewriting existing signed params. */
			const appendQueryParam = (url: string, key: string, value: string): string => {
				if (new RegExp(`[?&]${key}=`).test(url)) return url;
				return `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
			};

			const parseCaptionPayload = async (
				response: Response,
			): Promise<{ text: string; status: number; preview: string }> => {
				const status = response.status;
				const bodyText = await response.text();
				const preview = bodyText.slice(0, 120).replace(/\s+/g, " ");
				if (!response.ok) {
					return { text: "", status, preview };
				}
				if (!bodyText.trim()) {
					return { text: "", status, preview: "(empty body)" };
				}
				const contentType = response.headers.get("content-type") ?? "";
				const trimmed = bodyText.trimStart();

				// json3 timedtext
				if (
					contentType.includes("json") ||
					trimmed.startsWith("{") ||
					trimmed.startsWith("[")
				) {
					try {
						const captions = JSON.parse(bodyText) as CaptionResponse & {
							wireMagic?: string;
						};
						// One event ≈ one cue line (preserve boundaries for unitize).
						const fromEvents = normalizeText(
							(captions.events ?? [])
								.map((event) =>
									(event.segs ?? [])
										.map((segment) => segment.utf8 ?? "")
										.join(""),
								)
								.map((line) => line.replace(/\s+/g, " ").trim())
								.filter((line) => line && line !== "\n")
								.join("\n"),
						);
						if (fromEvents.length >= MIN_TRANSCRIPT_CHARS) {
							return { text: fromEvents, status, preview };
						}
					} catch {
						// Fall through.
					}
				}

				// Classic XML: <text start="…" dur="…">cue</text>
				if (
					trimmed.startsWith("<?xml") ||
					trimmed.startsWith("<transcript") ||
					trimmed.includes("<text ")
				) {
					// Current auto-captions can use timedtext format 3:
					// <p ...><s>word</s><s> next</s></p>.
					const paragraphCues = [
						...bodyText.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/giu),
					]
						.map((match) =>
							normalizeText(
								decodeXmlEntities(match[1].replace(/<[^>]+>/g, " ")),
							),
						)
						.filter(Boolean);
					const paragraphText = normalizeText(paragraphCues.join("\n"));
					if (paragraphText.length >= MIN_TRANSCRIPT_CHARS) {
						return { text: paragraphText, status, preview };
					}

					const cues = [
						...bodyText.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/giu),
					]
						.map((m) =>
							normalizeText(
								decodeXmlEntities(m[1].replace(/<[^>]+>/g, " ")),
							),
						)
						.filter(Boolean);
					const text = normalizeText(cues.join("\n"));
					if (text.length >= MIN_TRANSCRIPT_CHARS) {
						return { text, status, preview };
					}
				}

				// WebVTT
				if (
					trimmed.startsWith("WEBVTT") ||
					contentType.includes("vtt") ||
					bodyText.includes("-->")
				) {
					const lines = bodyText
						.split(/\r?\n/)
						.map((l) => l.trim())
						.filter(
							(l) =>
								l &&
								!l.startsWith("WEBVTT") &&
								!l.startsWith("NOTE") &&
								!/^\d+$/.test(l) &&
								!/-->/.test(l) &&
								!/^KIND:|^LANGUAGE:/i.test(l),
						)
						.map((l) => normalizeText(decodeXmlEntities(l.replace(/<[^>]+>/g, " "))))
						.filter(Boolean);
					const text = normalizeText(lines.join("\n"));
					if (text.length >= MIN_TRANSCRIPT_CHARS) {
						return { text, status, preview };
					}
				}

				// Generic tag strip fallback (srv1 / plain)
				const text = normalizeText(
					decodeXmlEntities(
						bodyText
							.replace(/<script[\s\S]*?<\/script>/giu, " ")
							.replace(/<style[\s\S]*?<\/style>/giu, " ")
							.replace(/<[^>]+>/g, " ")
							.replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->.*/g, " "),
					),
				);
				return { text, status, preview };
			};

			/**
			 * Fetch one caption track. Signed baseUrl often returns empty if fmt is
			 * rewritten via URLSearchParams; try raw URL + append-only fmt variants,
			 * then timedtext by videoId+lang as fallback.
			 */
			const fetchCaptionText = async (track: CaptionTrack): Promise<string> => {
				if (!track.baseUrl) {
					debug.lastError = "caption track has no baseUrl";
					return "";
				}

				const attempts: string[] = [track.baseUrl];
				for (const fmt of ["json3", "srv3", "srv1", "vtt", "ttml"]) {
					attempts.push(appendQueryParam(track.baseUrl, "fmt", fmt));
				}
				// Dedupe while preserving order.
				const uniqueAttempts = [...new Set(attempts)];

				let lastStatus = 0;
				let lastPreview = "";
				for (const url of uniqueAttempts) {
					try {
						const response = await fetch(url, {
							credentials: "include",
							headers: { Accept: "*/*" },
						});
						const parsed = await parseCaptionPayload(response);
						lastStatus = parsed.status;
						lastPreview = parsed.preview;
						if (parsed.text.length >= MIN_TRANSCRIPT_CHARS) {
							return parsed.text;
						}
					} catch (error) {
						debug.lastError =
							error instanceof Error ? error.message : String(error);
					}
				}

				// Fallback: timedtext list API with this track's language/kind.
				if (videoId && track.languageCode) {
					const lang = track.languageCode;
					const kinds =
						track.kind === "asr" ? ["asr", undefined] : [undefined, "asr"];
					for (const kind of kinds) {
						for (const fmt of ["json3", "srv3", "vtt", "srv1"]) {
							try {
								const url = new URL("https://www.youtube.com/api/timedtext");
								url.searchParams.set("v", videoId);
								url.searchParams.set("lang", lang);
								url.searchParams.set("fmt", fmt);
								if (kind) url.searchParams.set("kind", kind);
								const response = await fetch(url.toString(), {
									credentials: "include",
								});
								const parsed = await parseCaptionPayload(response);
								lastStatus = parsed.status;
								lastPreview = parsed.preview;
								if (parsed.text.length >= MIN_TRANSCRIPT_CHARS) {
									return parsed.text;
								}
							} catch {
								// try next
							}
						}
					}
				}

				debug.lastError = `caption HTTP ${lastStatus} preview=${lastPreview}`;
				return "";
			};

			const fetchTimedTextListLangs = async (): Promise<string[]> => {
				if (!videoId) return [];
				try {
					const listUrl = new URL("https://www.youtube.com/api/timedtext");
					listUrl.searchParams.set("type", "list");
					listUrl.searchParams.set("v", videoId);
					const response = await fetch(listUrl.toString(), {
						credentials: "include",
					});
					if (!response.ok) return [];
					const xml = await response.text();
					const langs = [...xml.matchAll(/\blang_code="([^"]+)"/g)].map(
						(match) => match[1],
					);
					return langs;
				} catch {
					return [];
				}
			};

			const fetchTimedTextByVideoId = async (): Promise<string> => {
				if (!videoId) return "";
				const listed = await fetchTimedTextListLangs();
				const preferredFirst = preferred
					? listed.filter(
							(lang) =>
								lang === preferred || lang.startsWith(`${preferred}-`),
						)
					: [];
				const langs = [
					...preferredFirst,
					...(preferred ? [preferred] : []),
					...listed,
					"ru",
					"en",
				];
				const unique = [...new Set(langs.filter(Boolean))];

				for (const lang of unique) {
					for (const kind of [undefined, "asr"]) {
						for (const fmt of ["json3", "srv3", "vtt"]) {
							try {
								const url = new URL("https://www.youtube.com/api/timedtext");
								url.searchParams.set("v", videoId);
								url.searchParams.set("fmt", fmt);
								url.searchParams.set("lang", lang);
								if (kind) url.searchParams.set("kind", kind);
								const response = await fetch(url.toString(), {
									credentials: "include",
								});
								const parsed = await parseCaptionPayload(response);
								if (parsed.text.length >= MIN_TRANSCRIPT_CHARS) {
									return parsed.text;
								}
							} catch (error) {
								debug.lastError =
									error instanceof Error ? error.message : String(error);
							}
						}
					}
				}
				return "";
			};

			/**
			 * WEB caption URLs increasingly require a player proof token and answer with
			 * HTTP 200 + an empty body. The official Android Innertube player response
			 * currently exposes an equivalent caption URL that does not require that
			 * page-only token.
			 */
			const fetchAndroidPlayerCaptions = async (): Promise<string> => {
				if (!videoId) return "";
				const apiKey = ytcfgGet("INNERTUBE_API_KEY");
				if (typeof apiKey !== "string" || !apiKey) return "";
				const clientVersion = "20.10.38";
				try {
					const playerUrl = new URL(
						"https://www.youtube.com/youtubei/v1/player",
					);
					playerUrl.searchParams.set("key", apiKey);
					const response = await fetch(playerUrl.toString(), {
						method: "POST",
						credentials: "include",
						headers: {
							"content-type": "application/json",
							"X-Youtube-Client-Name": "3",
							"X-Youtube-Client-Version": clientVersion,
						},
						body: JSON.stringify({
							videoId,
							context: {
								client: {
									clientName: "ANDROID",
									clientVersion,
									hl: preferred?.split("-")[0] || "en",
									gl: "US",
								},
							},
							contentCheckOk: true,
							racyCheckOk: true,
						}),
					});
					if (!response.ok) {
						debug.lastError = `Android player HTTP ${response.status}`;
						return "";
					}
					const androidPlayer = (await response.json()) as PlayerResponse;
					const androidTracks =
						androidPlayer.captions?.playerCaptionsTracklistRenderer
							?.captionTracks ?? [];
					for (const track of pickCaptionTracks(androidTracks)) {
						const text = await fetchCaptionText(track);
						if (text.length >= MIN_TRANSCRIPT_CHARS) return text;
					}
				} catch (error) {
					debug.lastError =
						error instanceof Error ? error.message : String(error);
				}
				return "";
			};

			const walkDeep = (
				root: Node,
				visit: (node: Element) => void,
			): void => {
				const stack: Node[] = [root];
				while (stack.length > 0) {
					const node = stack.pop();
					if (!node) continue;
					if (node.nodeType === Node.ELEMENT_NODE) {
						const el = node as Element;
						visit(el);
						const shadow = (el as HTMLElement).shadowRoot;
						if (shadow) stack.push(shadow);
					}
					const children = (node as ParentNode).children;
					if (children) {
						for (let i = 0; i < children.length; i += 1) {
							stack.push(children[i]);
						}
					}
				}
			};

			const queryAllDeep = (selector: string): Element[] => {
				const found: Element[] = [];
				walkDeep(document.documentElement, (el) => {
					try {
						if (el.matches?.(selector)) found.push(el);
					} catch {
						// Invalid selector for this element type.
					}
				});
				return found;
			};

			const findTranscriptParams = (value: unknown): string | null => {
				const stack: unknown[] = [value];
				const seen = new Set<unknown>();
				while (stack.length > 0) {
					const current = stack.pop();
					if (!current || typeof current !== "object") continue;
					if (seen.has(current)) continue;
					seen.add(current);
					const record = current as Record<string, unknown>;
					const endpoint = record.getTranscriptEndpoint as
						| { params?: string }
						| undefined;
					if (typeof endpoint?.params === "string" && endpoint.params) {
						return endpoint.params;
					}
					if (
						typeof record.params === "string" &&
						record.params.length > 20 &&
						(JSON.stringify(record).includes("getTranscript") ||
							JSON.stringify(record).includes("transcript"))
					) {
						// keep scanning for explicit endpoint first
					}
					for (const nested of Object.values(record)) {
						stack.push(nested);
					}
				}
				return null;
			};

			const extractCuesFromUnknown = (value: unknown): string[] => {
				const lines: string[] = [];
				const stack: unknown[] = [value];
				const seen = new Set<unknown>();
				while (stack.length > 0) {
					const current = stack.pop();
					if (!current || typeof current !== "object") continue;
					if (seen.has(current)) continue;
					seen.add(current);
					const record = current as Record<string, unknown>;
					const snippet =
						(record.snippet as { runs?: Array<{ text?: string }> } | undefined) ??
						(record.transcriptSegmentRenderer as
							| { snippet?: { runs?: Array<{ text?: string }> } }
							| undefined)?.snippet;
					if (snippet?.runs) {
						const text = normalizeText(
							snippet.runs.map((run) => run.text ?? "").join(""),
						);
						if (text.length > 1) lines.push(text);
					}
					for (const nested of Object.values(record)) stack.push(nested);
				}
				return lines;
			};

			const fetchInnertubeTranscript = async (): Promise<string> => {
				const apiKey = ytcfgGet("INNERTUBE_API_KEY");
				const context = ytcfgGet("INNERTUBE_CONTEXT");
				if (typeof apiKey !== "string" || !context || typeof context !== "object") {
					return "";
				}

				let params =
					findTranscriptParams(pageWindow.ytInitialData) ??
					findTranscriptParams(playerResponse);

				if (!params && videoId) {
					try {
						const nextUrl = new URL(
							"https://www.youtube.com/youtubei/v1/next",
						);
						nextUrl.searchParams.set("key", apiKey);
						const nextResponse = await fetch(nextUrl.toString(), {
							method: "POST",
							credentials: "include",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								context,
								videoId,
							}),
						});
						if (nextResponse.ok) {
							const nextJson = await nextResponse.json();
							params = findTranscriptParams(nextJson);
						}
					} catch {
						// Optional path only.
					}
				}

				// Skip call without real engagement params (avoids noisy HTTP 400).
				if (!params) return "";

				try {
					const transcriptUrl = new URL(
						"https://www.youtube.com/youtubei/v1/get_transcript",
					);
					transcriptUrl.searchParams.set("key", apiKey);
					const response = await fetch(transcriptUrl.toString(), {
						method: "POST",
						credentials: "include",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ context, params }),
					});
					if (!response.ok) {
						// Do not overwrite a more useful caption error.
						if (!debug.lastError?.startsWith("caption")) {
							debug.lastError = `get_transcript HTTP ${response.status}`;
						}
						return "";
					}
					const json = await response.json();
					const lines = extractCuesFromUnknown(json);
					const text = normalizeText(lines.join(" "));
					return text.length >= MIN_TRANSCRIPT_CHARS ? text : "";
				} catch (error) {
					if (!debug.lastError?.startsWith("caption")) {
						debug.lastError =
							error instanceof Error ? error.message : String(error);
					}
					return "";
				}
			};

			const isTranscriptChromeLabel = (label: string): boolean =>
				/показать текст видео|show (?:video )?transcript|показать расшифровку|расшифровк|субтитры|search in transcript|поиск в расшифровке/i.test(
					label,
				);

			type CueLine = { seconds: number; text: string };

			/** Inline shelf detector (MAIN world cannot import extension modules). */
			const isShelfNoiseInline = (text: string): boolean => {
				const s = text.replace(/\s+/g, " ").trim();
				if (!s || s.length < 12) return false;
				const lower = s.toLocaleLowerCase();
				if (/\bновинка\b/iu.test(lower) || /\bавтодубляж\b/iu.test(lower)) {
					return true;
				}
				if (/\bnexta\b/iu.test(lower)) return true;
				if (
					/\d[\d\s,.]*\s*тыс\.?\s*(?:назад|[гдлм]\.?|дн\.?|мес\.?|л\.?)/iu.test(
						lower,
					)
				) {
					return true;
				}
				const viewHits = (lower.match(/\d[\d\s,.]*\s*тыс/gu) ?? []).length;
				if (viewHits >= 2) return true;
				if (viewHits >= 1 && (s.match(/\s\/\s/g) ?? []).length >= 2 && s.length > 80) {
					return true;
				}
				return false;
			};

			const collectLinesFromRoot = (root: Element): CueLine[] => {
				const cues: CueLine[] = [];
				const pushCue = (raw: string) => {
					const seconds = parseCueSeconds(raw) ?? cues.length;
					const text = stripLeadingTimestamp(raw);
					if (text.length <= 1) return;
					if (isShelfNoiseInline(text)) return;
					cues.push({ seconds, text });
				};

				// Only real transcript segment nodes (not page-wide "segment-text").
				const segmentNodes: Element[] = [];
				walkDeep(root, (el) => {
					const tag = el.tagName?.toLowerCase?.() ?? "";
					const cls = typeof el.className === "string" ? el.className : "";
					const id = el.id ?? "";
					const isSegment =
						tag.includes("transcript-segment") ||
						cls.includes("transcript-segment") ||
						id === "segment-text" ||
						(cls.includes("segment-text") &&
							(tag.includes("transcript") ||
								Boolean(el.closest?.("ytd-transcript-renderer, ytd-transcript-body-renderer, ytd-transcript-segment-list-renderer, ytd-engagement-panel-section-list-renderer"))));
					if (isSegment) segmentNodes.push(el);
				});

				if (segmentNodes.length > 0) {
					for (const node of segmentNodes) {
						pushCue(node.textContent ?? "");
					}
					return cues;
				}

				const raw = (root.textContent ?? "")
					.split(/\n+/)
					.map((line) => normalizeText(line))
					.filter(Boolean);
				for (const line of raw) {
					if (/^(?:\d{1,2}:)?\d{1,2}:\d{2}\b/.test(line)) {
						pushCue(line);
					}
				}
				return cues;
			};

			const readRenderedTranscript = async (): Promise<string> => {
				// Transcript panel only — never document-wide "timestamp panels"
				// (those match video durations on recommendation cards).
				const selectors = [
					'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]',
					'ytd-engagement-panel-section-list-renderer[target-id*="transcript-search-panel"]',
					'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
					"ytd-transcript-renderer",
					"ytd-transcript-body-renderer",
					"ytd-transcript-segment-list-renderer",
					"ytd-transcript-search-panel-renderer",
					"ytd-transcript-search-panel-renderer #segments-container",
					'ytd-engagement-panel-section-list-renderer[target-id*="transcript"] #segments-container',
					"#panels ytd-transcript-renderer",
					"ytd-watch-flexy ytd-transcript-renderer",
				];
				const candidates: Element[] = [];
				for (const selector of selectors) {
					for (const node of queryAllDeep(selector)) {
						// Skip fully collapsed panels, but keep display:none only when empty.
						// Some YT builds keep the panel off-screen yet still hydrate segments.
						if (node instanceof HTMLElement) {
							const style = window.getComputedStyle(node);
							const targetId = (
								node.getAttribute("target-id") ??
								node.closest?.("[target-id]")?.getAttribute("target-id") ??
								""
							).toLocaleLowerCase();
							const isTranscriptPanel = targetId.includes("transcript");
							if (
								style.display === "none" &&
								!isTranscriptPanel &&
								!(node.textContent ?? "").trim()
							) {
								continue;
							}
						}
						if (!candidates.includes(node)) candidates.push(node);
					}
				}
				// #segments-container only if under a transcript ancestor.
				for (const node of queryAllDeep("#segments-container")) {
					const inTranscript = node.closest(
						"ytd-transcript-renderer, ytd-transcript-body-renderer, ytd-transcript-segment-list-renderer, ytd-engagement-panel-section-list-renderer",
					);
					if (inTranscript && !candidates.includes(node)) {
						candidates.push(node);
					}
				}

				debug.domRootCount = candidates.length;
				if (candidates.length === 0) {
					debug.domLineCount = 0;
					return "";
				}

				for (const root of candidates) {
					const scrollers: HTMLElement[] = [];
					walkDeep(root, (el) => {
						if (!(el instanceof HTMLElement)) return;
						const style = window.getComputedStyle(el);
						const scrollable =
							/(auto|scroll)/.test(style.overflowY) &&
							el.scrollHeight > el.clientHeight + 40;
						if (scrollable || el.id === "segments-container") {
							scrollers.push(el);
						}
					});
					for (const el of scrollers.slice(0, 3)) {
						const maxScroll = Math.min(el.scrollHeight, 12_000);
						for (let y = 0; y <= maxScroll; y += 400) {
							el.scrollTop = y;
							await new Promise((resolve) => setTimeout(resolve, 25));
						}
						el.scrollTop = 0;
					}
				}

				// Score each root separately; never union unrelated DOM trees
				// (union mixed recommendation rails into the speech transcript).
				const scoreRootTexts = (texts: string[]): number => {
					if (texts.length < 2) return -1;
					const joined = texts.join("\n");
					if (joined.length < MIN_TRANSCRIPT_CHARS) return -1;
					let shelf = 0;
					for (const t of texts) {
						if (isShelfNoiseInline(t)) shelf += 1;
					}
					if (shelf / texts.length > 0.25) return -1;
					const openingRe =
						/(?:^|[\s,.])(?:приветствую|здравствуй(?:те)?|добрый\s+(?:день|вечер)|хочу\s+выразить|хочу\s+вам\s+поклон|поклон(?:юсь|иться)|от\s+имени\s+всех|как\s+бы\s+я)/iu;
					const openBonus = openingRe.test(joined.slice(0, 800)) ? 200 : 0;
					return texts.length * 4 + Math.min(joined.length, 4000) * 0.05 + openBonus - shelf * 80;
				};

				let bestTexts: string[] = [];
				let bestRootScore = -1;
				for (const root of candidates) {
					const cues = collectLinesFromRoot(root);
					if (cues.length === 0) continue;
					cues.sort((a, b) => a.seconds - b.seconds);
					let texts = cues.map((cue) => cue.text).filter((t) => !isShelfNoiseInline(t));
					if (texts.length >= 6) {
						const openingRe =
							/(?:^|[\s,.])(?:приветствую|здравствуй(?:те)?|добрый\s+(?:день|вечер)|хочу\s+выразить|хочу\s+вам\s+поклон|поклон(?:юсь|иться)|от\s+имени\s+всех)/iu;
						const headN = Math.min(10, Math.max(3, Math.floor(texts.length * 0.15)));
						const head = texts.slice(0, headN).join(" ");
						const tail = texts.slice(texts.length - headN).join(" ");
						if (openingRe.test(tail) && !openingRe.test(head)) {
							texts = texts.slice().reverse();
						}
					}
					// Drop leading shelf residuals after chrono.
					while (texts.length > 0 && isShelfNoiseInline(texts[0])) {
						texts = texts.slice(1);
					}
					const sc = scoreRootTexts(texts);
					if (sc > bestRootScore) {
						bestRootScore = sc;
						bestTexts = texts;
					}
				}

				debug.domLineCount = bestTexts.length;
				const joined = normalizeText(bestTexts.join("\n"));
				return joined.length >= MIN_TRANSCRIPT_CHARS ? joined : "";
			};

			const openTranscriptPanel = async (): Promise<boolean> => {
				// Already showing cues.
				if ((await readRenderedTranscript()).length > 0) return true;

				const clickables = queryAllDeep(
					"button, [role='button'], tp-yt-paper-button, a, yt-button-shape button, yt-list-item-view-model, ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-view-model, ytd-button-renderer, ytd-compact-link-renderer",
				) as HTMLElement[];

				const scoreButton = (el: HTMLElement): number => {
					const aria = (el.getAttribute("aria-label") ?? "").trim();
					const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
					const cls = typeof el.className === "string" ? el.className : "";
					const combined = `${aria} ${text}`;
					let score = 0;
					if (
						/^показать текст видео$/i.test(aria) ||
						/^показать текст видео$/i.test(text) ||
						/^показать расшифровку$/i.test(text) ||
						/^расшифровка$/i.test(text)
					) {
						score += 100;
					}
					if (
						/^show (?:video )?transcript$/i.test(aria) ||
						/^show (?:video )?transcript$/i.test(text) ||
						/^show transcript$/i.test(text)
					) {
						score += 100;
					}
					if (isTranscriptChromeLabel(combined)) score += 40;
					if (/transcript|расшифров/i.test(combined)) score += 25;
					if (cls.includes("ytSpecButtonShapeNext")) score += 20;
					if (cls.includes("CallToAction")) score += 10;
					// Prefer leaf-ish buttons (short label).
					if (text.length > 0 && text.length < 48) score += 5;
					return score;
				};

				const clickEl = async (el: HTMLElement): Promise<void> => {
					try {
						el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
					} catch {
						// ignore
					}
					try {
						el.click();
					} catch {
						el.dispatchEvent(
							new MouseEvent("click", { bubbles: true, cancelable: true }),
						);
					}
					await new Promise((resolve) => setTimeout(resolve, 900));
				};

				// Path A: direct transcript CTA on the page.
				const ranked = clickables
					.map((el) => ({ el, score: scoreButton(el) }))
					.filter((entry) => entry.score >= 40)
					.sort((a, b) => b.score - a.score);

				if (ranked[0]?.el) {
					await clickEl(ranked[0].el);
					if ((await readRenderedTranscript()).length > 0) return true;
				}

				// Path B: ⋯ / More actions menu → Show transcript (common on desktop).
				const moreButtons = clickables.filter((el) => {
					const aria = (el.getAttribute("aria-label") ?? "").toLocaleLowerCase();
					const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
					return (
						/more actions|дополнительн|ещё|еще|другие действия/i.test(aria) ||
						/more actions|дополнительн/i.test(text) ||
						el.getAttribute("aria-haspopup") === "menu"
					);
				});
				for (const more of moreButtons.slice(0, 4)) {
					await clickEl(more);
					const menuItems = queryAllDeep(
						"ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-item-view-model, [role='menuitem']",
					) as HTMLElement[];
					const item =
						menuItems
							.map((el) => ({ el, score: scoreButton(el) }))
							.filter((e) => e.score >= 40)
							.sort((a, b) => b.score - a.score)[0]?.el ?? null;
					if (item) {
						await clickEl(item);
						if ((await readRenderedTranscript()).length > 0) return true;
					}
				}

				return (await readRenderedTranscript()).length > 0;
			};

			const finish = (
				text: string,
				kind: "transcript" | "metadata",
				source: string,
			): YouTubePageContent => {
				debug.source = source;
				return { text, kind, title, debug };
			};

			/** Higher is better: cue newlines, speech openers; shelf rails score very low. */
			const scoreTranscriptText = (text: string): number => {
				const t = text.trim();
				if (t.length < MIN_TRANSCRIPT_CHARS) return -1;
				// Hard reject pure / head-heavy recommendation shelf scrapes.
				const head = t.slice(0, Math.min(700, t.length));
				if (isShelfNoiseInline(head) && !/хочу\s+выразить|как\s+бы\s+я|здравствуй/iu.test(head)) {
					return -1;
				}
				const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
				let shelfLines = 0;
				for (const line of lines) {
					if (isShelfNoiseInline(line)) shelfLines += 1;
				}
				const shelfFrac = lines.length ? shelfLines / lines.length : 0;
				if (shelfFrac > 0.35) return -1;
				const lineBonus = Math.min(120, lines.length * 3);
				const missingLetterHits = (
					t.match(
						/(?:^|[\s])(?:то|еловек|еловеч|ём|ётк|тности|исле)(?=[\s.,]|$)/giu,
					) ?? []
				).length;
				const capitalLines = lines.filter((l) =>
					/^[\p{Lu}А-ЯЁ]/u.test(l.trim()),
				).length;
				const capitalBonus = Math.min(40, capitalLines * 2);
				const openBonus =
					/(?:^|[\s,.])(?:приветствую|здравствуй|хочу\s+выразить|как\s+бы\s+я)/iu.test(
						t.slice(0, 600),
					)
						? 150
						: 0;
				const shelfPenalty = shelfLines * 120 + (isShelfNoiseInline(head) ? 400 : 0);
				return (
					t.length +
					lineBonus +
					capitalBonus +
					openBonus -
					missingLetterHits * 8 -
					shelfPenalty
				);
			};

			type Candidate = { text: string; source: string; score: number };
			let best: Candidate = { text: "", source: "", score: -1 };
			const consider = (text: string, source: string) => {
				// Drop leading shelf before scoring (DOM sometimes prepends related rails).
				const lines = text
					.split(/\n+/)
					.map((l) => l.trim())
					.filter(Boolean);
				let start = 0;
				while (start < lines.length && isShelfNoiseInline(lines[start])) {
					start += 1;
				}
				// Single glued blob: shelf + speech.
				let cleaned = start > 0 ? lines.slice(start).join("\n") : text;
				if (start === 0 && lines.length <= 2) {
					const one = lines.join(" ");
					const m = one.match(
						/(?:^|[\s])((?:лексей|алексей|как\s+бы|хочу\s+выразить).+)$/iu,
					);
					if (m && isShelfNoiseInline(one.slice(0, m.index ?? 0))) {
						cleaned = m[1];
					}
				}
				const score = scoreTranscriptText(cleaned);
				if (score < 0) return;
				// Prefer clean caption sources over dirty DOM when scores are close.
				const preferClean =
					!source.startsWith("dom") &&
					best.source.startsWith("dom") &&
					score >= best.score * 0.85;
				if (score > best.score || preferClean) {
					best = { text: cleaned, source, score };
				}
			};

			// 1) Caption tracks first (stable API; avoid thrashing the transcript UI).
			const tracks =
				playerResponse?.captions?.playerCaptionsTracklistRenderer
					?.captionTracks ?? [];
			debug.trackCount = tracks.length;
			for (const track of pickCaptionTracks(tracks)) {
				const captionText = await fetchCaptionText(track);
				const label =
					track.kind === "asr" ? "caption-asr" : "caption-track";
				if (captionText) consider(captionText, label);
			}

			// WEB signed caption URLs may be present yet return an empty body.
			if (best.score < 0) {
				const androidCaptionText = await fetchAndroidPlayerCaptions();
				if (androidCaptionText) {
					consider(androidCaptionText, "caption-android");
				}
			}

			// 2) timedtext + innertube (no UI open).
			const timedText = await fetchTimedTextByVideoId();
			if (timedText) consider(timedText, "timedtext");

			const innertubeText = await fetchInnertubeTranscript();
			if (innertubeText) consider(innertubeText, "innertube");

			// 3) DOM transcript panel only if caption APIs failed / weak.
			let rendered = await readRenderedTranscript();
			if (rendered) consider(rendered, "dom");

			if (best.score < 400) {
				const opened = await openTranscriptPanel();
				if (opened) {
					// Single open + poll (do not re-click every few hundred ms).
					for (let attempt = 0; attempt < 12; attempt += 1) {
						await new Promise((resolve) => setTimeout(resolve, 350));
						rendered = await readRenderedTranscript();
						if (rendered) consider(rendered, "dom-poll");
						if (debug.domLineCount >= 15 && best.score >= 600) break;
					}
				}
			}

			if (best.score >= 0 && best.text) {
				return finish(best.text, "transcript", best.source);
			}

			const textFromRuns = (value: unknown): string => {
				if (!value || typeof value !== "object") return "";
				const record = value as Record<string, unknown>;
				if (typeof record.simpleText === "string") return record.simpleText;
				if (!Array.isArray(record.runs)) return "";
				return record.runs
					.map((run) =>
						run &&
						typeof run === "object" &&
						typeof (run as Record<string, unknown>).text === "string"
							? ((run as Record<string, unknown>).text as string)
							: "",
					)
					.join("");
			};

			const chapters: string[] = [];
			const visit = (value: unknown): void => {
				if (!value || typeof value !== "object") return;
				if (Array.isArray(value)) {
					for (const item of value) visit(item);
					return;
				}
				const record = value as Record<string, unknown>;
				const marker = record.macroMarkersListItemRenderer;
				if (marker && typeof marker === "object") {
					const markerRecord = marker as Record<string, unknown>;
					const chapterTitle = textFromRuns(markerRecord.title);
					const timestamp = textFromRuns(markerRecord.timeDescription);
					const line = normalizeText(`${timestamp} ${chapterTitle}`);
					if (line && !chapters.includes(line)) chapters.push(line);
				}
				for (const nested of Object.values(record)) visit(nested);
			};
			visit(pageWindow.ytInitialData);

			if (chapters.length > 0) {
				return finish(
					`Video chapters:\n${chapters.map((chapter) => `- ${chapter}`).join("\n")}`,
					"metadata",
					"chapters",
				);
			}

			const description = (playerResponse?.videoDetails?.shortDescription ?? "")
				.split("\n")
				.map((line) =>
					line.replace(/https?:\/\/\S+/giu, "").replace(/#\S+/gu, "").trim(),
				)
				.filter((line) => (line.match(/[\p{L}\p{N}]/gu) ?? []).length >= 20)
				.slice(0, 30)
				.join("\n");

			if (description) {
				return finish(description, "metadata", "description");
			}

			return { text: "", kind: "empty", title, debug };
}

function cleanArticleMarkdown(html: string, pageUrl: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const base = doc.createElement("base");
	base.href = pageUrl;
	doc.head.prepend(base);
	const article = new Readability(doc).parse();
	if (!article?.content) {
		throw new Error("Failed to extract readable content from the active page");
	}

	const turndownService = new TurndownService({
		headingStyle: "atx",
		bulletListMarker: "-",
	});
	turndownService.addRule("plain-links", {
		filter: "a",
		replacement: (content) => content,
	});
	turndownService.remove(["img", "script", "style", "noscript", "form", "button"]);

	return turndownService
		.turndown(article.content)
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
		.filter((line) => !/^https?:\/\/\S+$/iu.test(line.trim()))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function resolveActivePageTab(): Promise<{
	id: number;
	url: string;
	title?: string;
}> {
	const active = await getActiveBrowserTab();
	if (!active?.id || !active.url) {
		throw new Error("No active web page found");
	}

	const tab = await chrome.tabs.get(active.id);
	const url = tab.url || tab.pendingUrl || active.url;
	if (!url) {
		throw new Error("No active web page found");
	}

	return {
		id: active.id,
		url,
		title: tab.title,
	};
}

export async function summarizeWebPage(language: TranscriptionLanguage): Promise<string> {
	const tab = await resolveActivePageTab();

	const [{ result: html }] = await chrome.scripting.executeScript({
		target: { tabId: tab.id },
		func: () => document.documentElement.outerHTML,
	});
	if (!html) {
		throw new Error("Failed to read the active page");
	}

	const content = cleanArticleMarkdown(html, tab.url);
	const title = tab.title?.trim() || "Web page";
	const summary = await summarizeText(content, {
		language,
		systemPrompt: SUMMARY_SYSTEM_PROMPT,
	});

	return `# [${title}](${tab.url})\n\n${summary}`;
}

export async function summarizeVideoTranscript(
	language: TranscriptionLanguage,
): Promise<string> {
	const tab = await resolveActivePageTab();
	if (!isYouTubeWatchUrl(tab.url)) {
		throw new Error(
			"Video transcript is only available on YouTube. Open a YouTube video tab and try again.",
		);
	}
	if (!isYouTubeVideoPageUrl(tab.url)) {
		throw new Error(
			"Open a YouTube video page (watch/shorts), not the homepage or search results, then try again.",
		);
	}

	const preferredLanguageCode = toBcp47Language(language);
	const youtubeContent = await extractYouTubePageContent(
		tab.id,
		preferredLanguageCode,
	);

	if (youtubeContent.debug) {
		console.info("[YouTubeTranscript]", youtubeContent.debug);
	}

	if (!youtubeContent.text || youtubeContent.kind !== "transcript") {
		const debugHint = youtubeContent.debug
			? ` (videoId=${youtubeContent.debug.videoId ?? "?"}, tracks=${youtubeContent.debug.trackCount}, domRoots=${youtubeContent.debug.domRootCount}, domLines=${youtubeContent.debug.domLineCount}, err=${youtubeContent.debug.lastError ?? "none"})`
			: "";
		throw new Error(
			`Could not read YouTube captions/transcript for this video. Open «Show transcript» / «Расшифровка видео» on the watch page (leave the panel open) and try again.${debugHint}`,
		);
	}

	const title =
		youtubeContent.title?.trim() || tab.title?.trim() || "YouTube video";

	// --- Cleaning stages (shown in output so quality can be inspected) ---
	// Stage 1: timecodes scrub + glue per episode block
	const stage1 = cleanYouTubeTranscriptText(youtubeContent.text);
	if (stage1.length < 40) {
		throw new Error(
			"Transcript was extracted but only noise/timestamps remained after cleanup. Try again with the transcript panel open.",
		);
	}
	// Stage 2: ASR loops, doubles, stage labels (no unit drop)
	const stage2 = applyMechanicalAsrClean(stage1);

	// Summarize the full video; the title also anchors the E5 topic query.
	const topicHint = title.replace(/\s*[|·\-–—].*$/u, "").trim();
	const cloudSettings = await loadCloudAiSettings();
	const scopeOptions: BuildScopesOptions = {
		fullOutline: true,
		topicHint,
		localSummaryModel: cloudSettings.localSummaryModel,
		summaryRatioTarget: cloudSettings.summaryRatioTarget,
		summaryRatioMin: cloudSettings.summaryRatioMin,
		summaryRatioMax: cloudSettings.summaryRatioMax,
		chronoWindows: cloudSettings.chronoWindows,
		maxBullets: cloudSettings.maxBullets,
		minBullets: cloudSettings.minBullets,
		maxBulletChars: cloudSettings.maxBulletChars,
	};
	// Stage 3: concise units after sanitize + quality filter (ranking input)
	const stage3 = formatRankingUnitsDebug(stage2, scopeOptions);

	// Extractive baseline first (faithful ~configured % budget). Generative may win only if accepted.
	const localSummary = await summarizeLocally(
		`${VIDEO_TRANSCRIPT_SUMMARY_SYSTEM_PROMPT}\n\n${stage2}`,
		language,
		scopeOptions,
	);
	const twoPass = cloudSettings.allowBrowserAi
		? await summarizeTranscriptTwoPass(stage2, language, scopeOptions)
		: null;
	let summary = localSummary;
	let usedTwoPass = false;
	if (
		twoPass &&
		isAcceptableGeneratedSummary(twoPass, stage2, scopeOptions)
	) {
		summary = twoPass;
		usedTwoPass = true;
	}

	// Polish only when we stayed on extractive; accept only if grounded and not shrunk.
	if (!usedTwoPass && cloudSettings.allowPolish && summary) {
		const priorBody = summaryBodyChars(summary);
		const polished = await polishExtractiveNotesWithFallback(
			summary,
			language,
			topicHint,
		);
		if (
			polished &&
			isAcceptableGeneratedSummary(polished, stage2, {
				...scopeOptions,
				priorBodyChars: priorBody,
				minBodyRatioOfPrior: 0.85,
			})
		) {
			summary = polished;
		}
	}

	/** Cap display size so a 10h transcript does not freeze the panel. */
	const preview = (text: string, max = 12_000): string => {
		const t = text.trim();
		if (t.length <= max) return t;
		return `${t.slice(0, max)}\n\n… (truncated for display, ${t.length} chars total)`;
	};

	const sourceHint = youtubeContent.debug?.source
		? ` (source: ${youtubeContent.debug.source})`
		: "";

	// Summary first; pipeline stages optional (Phase B: includePipelineDebug).
	const parts: string[] = ["## Summary", summary];
	if (cloudSettings.includePipelineDebug) {
		parts.push(
			"-----",
			"## Pipeline debug",
			`Source: ${youtubeContent.debug?.source ?? "unknown"} · Stage 3 units listed below`,
			"-----",
			`## Stage 1 — Timecodes scrub + glue${sourceHint}`,
			preview(stage1),
			"-----",
			"## Stage 2 — ASR glitches (loops, doubles, stage labels)",
			preview(stage2 || "(empty after mechanical ASR clean)"),
			"-----",
			"## Stage 3 — Units after sanitize (ranking input)",
			preview(stage3),
		);
	}

	return `# [${title}](${tab.url})\n\n${parts.join("\n\n")}`;
}
