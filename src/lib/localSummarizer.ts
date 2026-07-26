// cSpell:disable — model ids and ML jargon are intentional.
import type { TranscriptionLanguage } from "@/jotai/transcriptionSettings";
import type { LocalSummaryModel } from "@/lib/cloudAiSettings";
import {
	collapseAsrLoops,
	endsIncomplete,
	fixAsrGlitches,
	hasThesisGlue,
	isBulletEligible,
	isHardDropUnit,
	isIncompleteThought,
	doubleMergeIncompleteUnits,
	sanitizeSummaryUnits,
	splitLongUnitsForEmbed,
	startsContinuationOpener,
	startsMidPhraseOpener,
	stripLeadingFillers,
	stripSpeechDebris,
	tokenizeWords,
	trimTrailingTopicJump,
	truncateAtClauseBoundary,
	unitInfoScore,
	validateSummaryBullet,
} from "@/lib/asrCleaner";

/** Local ONNX summarizers use the same Transformers.js stack as Whisper. */
const EN_SUMMARIZATION_MODEL = "Xenova/distilbart-cnn-6-6";
/** Fine-tuned Russian abstractive summarizer retained as the fast option. */
const RU_SUMMARIZATION_MODEL = "onnx-community/rut5_base_sum_gazeta-ONNX";
/** Instruction-following local models for coherent two-pass Russian summaries. */
const QWEN_BALANCED_MODEL = "onnx-community/Qwen3-0.6B-ONNX";
const QWEN_QUALITY_MODEL = "onnx-community/Qwen3-1.7B-ONNX";
/** Multilingual extractive fallback when a generative model cannot load. */
const MULTI_EMBED_MODEL = "Xenova/multilingual-e5-small";
/** Document units / LexRank graph / diversity. */
const E5_PASSAGE_PREFIX = "passage: ";
/** Topic vector Q for asymmetric MMR relevance (HF E5 docs). */
const E5_QUERY_PREFIX = "query: ";
/** Lex / topic / info blend weights (must sum to 1). */
const MMR_LEX_WEIGHT = 0.25;
const MMR_TOPIC_WEIGHT = 0.5;
const MMR_INFO_WEIGHT = 0.25;
/** Cosine edge threshold for LexRank graph on embedding space. */
const LEXRANK_EDGE_MIN = 0.35;

const MIN_NEURAL_INPUT_CHARS = 200;
const NEURAL_CHUNK_CHARS = 1_200;
const NEURAL_MAX_MAP_CHUNKS = 16;
const NEURAL_MAX_NEW_TOKENS = 128;
const NEURAL_MIN_NEW_TOKENS = 16;
const RU_NEURAL_CHUNK_CHARS = 1_400;
const RU_NEURAL_MAX_CHUNKS = 6;
const RU_NEURAL_MAX_NEW_TOKENS = 96;
const RU_NEURAL_MIN_NEW_TOKENS = 18;

const TEXTRANK_MAX_SENTENCES = 120;
const MAP_CHUNK_SENTENCES = 50;
/** Per-scope / single-window top-K when not covering full outline. */
const TEXTRANK_TOP_K = 6;
const SECTION_TOP_K = 5;
/** Prefer fewer complete bullets over mush padding. */
const MIN_SUMMARY_BULLETS = 2;
/** Soft target when many complete units exist (not a hard floor with incomplete fill). */
const PREFERRED_SUMMARY_BULLETS = 4;
/** Cap bullets after multi-window full-transcript merge (char budget dominates). */
const MAX_SUMMARY_BULLETS = 20;
/** Summary body length as a fraction of Stage 2 source. */
const SUMMARY_RATIO_TARGET = 0.1;
const SUMMARY_RATIO_MIN = 0.06;
const SUMMARY_RATIO_MAX = 0.15;
/** Typical extractive RU clause length for bullet-count estimate. */
const AVG_EXTRACTIVE_BULLET_CHARS = 230;
/** Minimum source length before enforcing the hard min ratio on generative. */
const SUMMARY_RATIO_ENFORCE_SOURCE_CHARS = 1_000;
/** Episode 1 + up to 7 later episodes (never mix units across episodes). */
const MAX_NAMED_SECTIONS = 8;
/** Full-transcript chrono windows (evenly includes first…last). */
const MAX_CHRONO_WINDOWS = 8;
const SIMILARITY_EDGE_MIN = 0.08;
const TEXTRANK_DAMPING = 0.85;
const TEXTRANK_ITERATIONS = 25;
const MMR_LAMBDA = 0.7;
const EMBED_MAX_UNITS = 200;
/** Default notes: first ~6k chars / ~80 units when no episode headers. */
const FIRST_SEGMENT_MAX_CHARS = 6_000;
const FIRST_SEGMENT_MAX_UNITS = 80;
/** Cosine near-dup after E5 (Phase A: keep higher unitInfoScore). */
const EMBED_NEAR_DUP_COS = 0.87;
const EMBED_NEAR_DUP_WINDOW = 6;
/** Max chars for topic query string (E5 512-token safety). */
const TOPIC_QUERY_MAX_CHARS = 480;
/** How many LexRank-central units form the query topic (fallback). */
const TOPIC_LEXRANK_TOP_K = 3;
/** Multi-centroid Q cluster count (Phase A). */
const TOPIC_CLUSTER_MAX_K = 4;
/** Keep ranking candidates and final extractive bullets concise. */
const RANKING_UNIT_SPLIT_THRESHOLD = 420;
const RANKING_UNIT_CHUNK_CHARS = 320;
/** Prefer complete sentences; soft display cap for extractive bullets. */
const MAX_OUTPUT_BULLET_CHARS = 480;

/** Answer-turn markers for Q/A discourse split (local-only, no domain keywords). */
const ANSWER_TURN_RE =
	/(?:^|\s)(?:хорошо|ладно|итак)(?:,?\s+(?:я\s+)?(?:вам\s+)?скажу)?\s+так(?=\s|$)|(?:^|\s)(?:мой\s+)?ответ\s+(?:таков|такой)|(?:^|\s)(?:well|my\s+answer\s+is|the\s+answer\s+is)\b/iu;

export type SummaryScope = {
	title: string;
	text: string;
	units: string[];
};

/** Tunable extractive knobs (from user settings; defaults match constants). */
export type SummaryTuningOptions = {
	summaryRatioTarget?: number;
	summaryRatioMin?: number;
	summaryRatioMax?: number;
	chronoWindows?: number;
	maxBullets?: number;
	minBullets?: number;
	maxBulletChars?: number;
};

export type BuildScopesOptions = SummaryTuningOptions & {
	/**
	 * When true and no episode headers: cover the full transcript via chrono windows
	 * (start → end). Default false: only the start of the transcript
	 * (avoids mid-video mash on long non-video notes).
	 * YouTube video summary always passes fullOutline: true.
	 */
	fullOutline?: boolean;
	maxNamedScopes?: number;
	firstSegmentMaxChars?: number;
	firstSegmentMaxUnits?: number;
	/** Video/page title for E5 query: topic vector (asymmetric ranking). */
	topicHint?: string;
	/** Local model used when browser-provided AI is unavailable. */
	localSummaryModel?: LocalSummaryModel;
};

type ResolvedTuning = {
	summaryRatioTarget: number;
	summaryRatioMin: number;
	summaryRatioMax: number;
	chronoWindows: number;
	maxBullets: number;
	minBullets: number;
	maxBulletChars: number;
};

function resolveTuning(options: SummaryTuningOptions = {}): ResolvedTuning {
	const target = options.summaryRatioTarget ?? SUMMARY_RATIO_TARGET;
	const min = options.summaryRatioMin ?? SUMMARY_RATIO_MIN;
	const max = options.summaryRatioMax ?? SUMMARY_RATIO_MAX;
	const minBullets = options.minBullets ?? MIN_SUMMARY_BULLETS;
	const maxBullets = options.maxBullets ?? MAX_SUMMARY_BULLETS;
	return {
		summaryRatioTarget: target,
		summaryRatioMin: Math.min(min, target),
		summaryRatioMax: Math.max(max, target),
		chronoWindows: options.chronoWindows ?? MAX_CHRONO_WINDOWS,
		maxBullets: Math.max(maxBullets, minBullets),
		minBullets: Math.min(minBullets, maxBullets),
		maxBulletChars: options.maxBulletChars ?? MAX_OUTPUT_BULLET_CHARS,
	};
}

/** Even index sample of windows including first and last. */
function pickEvenWindowIndexes(windowCount: number, maxWindows: number): number[] {
	if (windowCount <= 0) return [];
	if (windowCount <= maxWindows) {
		return Array.from({ length: windowCount }, (_, i) => i);
	}
	const indexes = new Set<number>();
	indexes.add(0);
	indexes.add(windowCount - 1);
	for (let i = 1; i < maxWindows - 1; i += 1) {
		indexes.add(
			Math.round((i * (windowCount - 1)) / (maxWindows - 1)),
		);
	}
	return [...indexes].sort((a, b) => a - b);
}

/**
 * Character budget for summary body relative to source transcript length.
 * Defaults ≈ 10% target (min 6% / max 15%); overridable via settings.
 */
export function summaryCharBudget(
	sourceChars: number,
	tuning: SummaryTuningOptions = {},
): {
	min: number;
	target: number;
	max: number;
} {
	const t = resolveTuning(tuning);
	const n = Math.max(0, Math.floor(sourceChars));
	if (n < 200) {
		return { min: 40, target: Math.max(80, Math.round(n * 0.2)), max: Math.max(120, n) };
	}
	return {
		min: Math.round(n * t.summaryRatioMin),
		target: Math.round(n * t.summaryRatioTarget),
		max: Math.round(n * t.summaryRatioMax),
	};
}

/** Count characters in markdown bullet bodies (ignore headers and list markers). */
export function summaryBodyChars(markdown: string): number {
	const lines = markdown.split(/\n+/).map((l) => l.trim()).filter(Boolean);
	let total = 0;
	for (const line of lines) {
		if (line.startsWith("#")) continue;
		const body = line.replace(/^[-*•]\s+/, "").trim();
		if (body) total += body.length;
	}
	return total;
}

/** Target bullet count for full-transcript extractive notes. */
function targetBulletCount(
	unitCount: number,
	fullOutline: boolean,
	sourceChars = 0,
	tuning: SummaryTuningOptions = {},
): number {
	const t = resolveTuning(tuning);
	if (sourceChars >= 400) {
		const { target } = summaryCharBudget(sourceChars, t);
		const n = Math.round(target / AVG_EXTRACTIVE_BULLET_CHARS);
		if (fullOutline) {
			return Math.min(t.maxBullets, Math.max(Math.max(4, t.minBullets), n));
		}
		return Math.min(8, Math.max(t.minBullets, n));
	}
	if (!fullOutline) {
		return Math.min(TEXTRANK_TOP_K, Math.max(t.minBullets, Math.ceil(unitCount / 12)));
	}
	if (unitCount < 15) return Math.min(6, Math.max(t.minBullets, unitCount));
	if (unitCount < 40) return Math.min(8, t.maxBullets);
	if (unitCount < 100) return Math.min(10, t.maxBullets);
	return Math.min(t.maxBullets, 12);
}

export type LocalSummarizerState = {
	status: "idle" | "loading" | "ready" | "extractive" | "summarizing";
	progress: number;
	detail?: string;
};

type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

type SummarizationResult = {
	summary_text?: string;
	generated_text?: string | ChatMessage[];
};
type GenericPipeline = ((
	input: string | ChatMessage[],
	options?: Record<string, unknown>,
) => Promise<SummarizationResult | SummarizationResult[]>) & {
	dispose?: () => void | Promise<void>;
};

type FeaturePipeline = ((
	text: string,
	options?: Record<string, unknown>,
) => Promise<{ data: Float32Array | number[] }>) & {
	dispose?: () => void | Promise<void>;
};

type ProgressInfo = {
	status: string;
	progress?: number;
};

type RankedSentence = {
	index: number;
	sentence: string;
	score: number;
};

type TextSection = { title: string; units: string[] };

let localState: LocalSummarizerState = { status: "idle", progress: 0 };
let enPipelinePromise: Promise<GenericPipeline> | null = null;
let ruPipelinePromise: Promise<GenericPipeline> | null = null;
type QwenSummaryModel = Exclude<LocalSummaryModel, "fast">;

const qwenPipelinePromises: Partial<Record<QwenSummaryModel, Promise<GenericPipeline>>> = {};
const qwenModelUnavailable = new Set<QwenSummaryModel>();
let embedPipelinePromise: Promise<FeaturePipeline> | null = null;
let enModelUnavailable = false;
let ruModelUnavailable = false;
let embedModelUnavailable = false;
const listeners = new Set<(state: LocalSummarizerState) => void>();

const STOP_WORDS = new Set([
	"about",
	"after",
	"also",
	"been",
	"before",
	"being",
	"between",
	"could",
	"from",
	"have",
	"into",
	"more",
	"other",
	"over",
	"such",
	"than",
	"that",
	"their",
	"there",
	"these",
	"they",
	"this",
	"through",
	"very",
	"were",
	"what",
	"when",
	"where",
	"which",
	"while",
	"with",
	"would",
	"your",
	"более",
	"было",
	"быть",
	"если",
	"есть",
	"когда",
	"который",
	"между",
	"может",
	"после",
	"потому",
	"перед",
	"также",
	"того",
	"только",
	"чтобы",
	"этого",
	"очень",
	"просто",
	"вообще",
	"здесь",
	"сейчас",
	"давайте",
	"например",
]);

function updateState(next: LocalSummarizerState): void {
	localState = next;
	for (const listener of listeners) {
		listener(next);
	}
}

export function getLocalSummarizerState(): LocalSummarizerState {
	return localState;
}

export function subscribeLocalSummarizerState(
	listener: (state: LocalSummarizerState) => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function getPromptContent(prompt: string): string {
	const separator = prompt.indexOf("\n\n");
	return (separator >= 0 ? prompt.slice(separator + 2) : prompt).trim();
}

function tokenize(text: string): string[] {
	return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
		(word) => !STOP_WORDS.has(word),
	);
}

const SECTION_HEADER_RE =
	/^(?:эпизод|часть|глава|раздел|episode|part|chapter|section)\s*\d+\b/iu;

function isSectionHeaderLine(line: string): boolean {
	const t = line.trim();
	if (!t) return false;
	if (SECTION_HEADER_RE.test(t)) return true;
	return /^(?:эпизод|часть|глава|episode|part|chapter)\s*\d+\s*[:.\-–—]/iu.test(
		t,
	);
}

function normalizePoint(sentence: string): string {
	return sentence
		.replace(/\s+/g, " ")
		.replace(/^[:\-–—•.,;\s]+/u, "")
		.replace(/[;,]+$/u, "")
		.trim();
}

const NOISE_MARKERS =
	/\[(?:неразборчиво|inaudible|crosstalk|music|applause|unk)\]|<unk>|\(неразборчиво\)/iu;

/**
 * Merge cleaned ASR lines into continuous prose (headers stay as anchors).
 */
function mergeLinesToText(text: string): {
	headers: Array<{ title: string; body: string }>;
	flatBody: string;
} {
	const lines = text
		.replace(/\r\n/g, "\n")
		.split(/\n+/)
		.map((l) => l.replace(/^[-*•]\s*/, "").trim())
		.filter(Boolean);

	const headers: Array<{ title: string; body: string }> = [];
	let title = "";
	let bodyParts: string[] = [];

	const flush = () => {
		// Keep newlines between caption cues for line-based unitization.
		const body = bodyParts
			.join("\n")
			.replace(/\n{2,}/g, "\n")
			.trim();
		if (title || body) headers.push({ title, body });
		title = "";
		bodyParts = [];
	};

	for (const line of lines) {
		if (isSectionHeaderLine(line)) {
			flush();
			title = normalizePoint(line);
			continue;
		}
		bodyParts.push(line);
	}
	flush();

	const flatBody = headers
		.map((h) => h.body.replace(/\n+/g, " "))
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();

	return { headers, flatBody };
}

/**
 * Merge short caption lines into utterance-sized units (≥ minTokens, ≤ maxChars).
 * Avoid char-budget flushes that leave an incomplete head + mid-phrase tail pair.
 */
function mergeCaptionLines(
	lines: string[],
	minTokens = 10,
	maxChars = 280,
): string[] {
	const out: string[] = [];
	let buf: string[] = [];
	let chars = 0;
	/** Soft stretch past maxChars to finish an incomplete thought. */
	const hardCap = Math.max(maxChars * 2.2, 620);

	const flush = () => {
		if (buf.length === 0) return;
		const piece = normalizePoint(buf.join(" "));
		if (piece) out.push(piece);
		buf = [];
		chars = 0;
	};

	const bufferText = () => buf.join(" ").replace(/\s+/g, " ").trim();

	for (const line of lines) {
		const t = line.trim();
		if (!t || isSectionHeaderLine(t)) {
			flush();
			continue;
		}
		const nextChars = chars + t.length + (buf.length ? 1 : 0);
		const tokensSoFar = tokenizeWords([...buf, t].join(" ")).length;
		const cur = bufferText();
		const wouldFlushOnBudget =
			buf.length > 0 && nextChars > maxChars && tokensSoFar >= minTokens;
		// Do not flush if current buffer is incomplete or next line continues mid-phrase.
		const holdForContinuity =
			wouldFlushOnBudget &&
			cur.length > 0 &&
			nextChars <= hardCap &&
			(endsIncomplete(cur) ||
				startsMidPhraseOpener(t) ||
				startsContinuationOpener(t));
		if (wouldFlushOnBudget && !holdForContinuity) {
			flush();
		}
		buf.push(t);
		chars = bufferText().length;
		const joined = bufferText();
		const tokenCount = tokenizeWords(joined).length;
		if (tokenCount >= minTokens && chars >= 80) {
			const last = t.split(/\s+/).pop() ?? "";
			const discourseBreak =
				/^(значит|смотрите|итак|поэтому|однако|дальше)$/iu.test(last);
			if (discourseBreak && !endsIncomplete(joined)) {
				flush();
			} else if (chars >= maxChars * 0.85 && !endsIncomplete(joined) && chars >= maxChars) {
				// Only hard-flush at budget when the buffer looks complete enough.
				flush();
			}
		}
		if (chars >= hardCap) flush();
	}
	flush();

	// Attach continuation crumbs to previous unit (caption split mid-thought).
	const merged: string[] = [];
	for (const unit of out) {
		const weakCont =
			startsMidPhraseOpener(unit) ||
			startsContinuationOpener(unit) ||
			/^что\s+вы(?:\s|$)/iu.test(unit);
		if (weakCont && merged.length > 0) {
			const prev = merged[merged.length - 1];
			if (prev.length + unit.length < hardCap * 1.1) {
				merged[merged.length - 1] = normalizePoint(`${prev} ${unit}`);
				continue;
			}
		}
		// Also attach when previous ends incomplete (even if next is not a listed opener).
		if (
			merged.length > 0 &&
			endsIncomplete(merged[merged.length - 1]) &&
			merged[merged.length - 1].length + unit.length < hardCap * 1.1
		) {
			merged[merged.length - 1] = normalizePoint(
				`${merged[merged.length - 1]} ${unit}`,
			);
			continue;
		}
		merged.push(unit);
	}
	// Incomplete endings + reverse-merge mid-phrase / continuation openers.
	return doubleMergeIncompleteUnits(merged, Math.max(720, hardCap));
}

/**
 * Split into ranking units: caption lines first; else punct sentences;
 * never soft-break on short Russian connectors (и|а|но|…).
 */
export function splitIntoSentences(text: string): string[] {
	const rawLines = text
		.replace(/\r\n/g, "\n")
		.split(/\n+/)
		.map((l) => l.replace(/^[-*•]\s*/, "").trim())
		.filter(Boolean);

	// Caption-style: many medium lines → merge, do not soft-shred.
	if (rawLines.length >= 4) {
		const contentLines = rawLines.filter((l) => !isSectionHeaderLine(l));
		const avg =
			contentLines.reduce((a, l) => a + l.length, 0) /
			Math.max(contentLines.length, 1);
		if (contentLines.length >= 4 && avg > 12 && avg < 320) {
			return filterNoiseSentences(mergeCaptionLines(contentLines));
		}
	}

	const unified = text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
	if (!unified) return [];

	const boundaryHits = (unified.match(/[.!?…](?=\s|$)/gu) ?? []).length;
	const sentences: string[] = [];

	if (boundaryHits >= 2) {
		const parts = unified.split(/(?<=[.!?…])\s+/u);
		for (const part of parts) {
			const sentence = normalizePoint(part);
			if (sentence) sentences.push(sentence);
		}
	} else {
		// Long windows only; no break on и|а|но|как|это.
		const words = unified.split(/\s+/);
		let buf: string[] = [];
		let len = 0;
		for (let i = 0; i < words.length; i += 1) {
			const word = words[i];
			buf.push(word);
			len += word.length + 1;
			const prev = words[i - 1] ?? "";
			const bigram = `${prev} ${word}`.toLocaleLowerCase();
			const strongBreak =
				len >= 200 &&
				(/^(значит|смотрите|итак|поэтому|однако|дальше)$/iu.test(word) ||
					bigram === "то есть" ||
					bigram === "кроме того");
			if (len >= 280 || strongBreak) {
				const piece = normalizePoint(buf.join(" "));
				if (piece.length >= 25) sentences.push(piece);
				buf = [];
				len = 0;
			}
		}
		if (buf.length > 0) {
			const piece = normalizePoint(buf.join(" "));
			if (piece.length >= 25) sentences.push(piece);
		}
	}

	return filterNoiseSentences(doubleMergeIncompleteUnits(sentences));
}

function filterNoiseSentences(sentences: string[]): string[] {
	const pre: string[] = [];
	for (const raw of sentences) {
		let s = normalizePoint(raw);
		if (!s || isSectionHeaderLine(s)) continue;
		if (NOISE_MARKERS.test(s)) {
			s = s.replace(NOISE_MARKERS, " ").replace(/\s+/g, " ").trim();
			if (s.length < 20 || (s.match(/[\p{L}]/gu) ?? []).length < 12) continue;
		}
		if (s.length < 15) continue;
		if ((s.match(/[\p{L}]/gu) ?? []).length < 10) continue;
		if ((s.match(/[\p{L}]/gu) ?? []).length < s.length * 0.35) continue;
		pre.push(s);
	}
	// ASR loop collapse + filler filter + Jaccard near-dup (before E5/LexRank).
	return sanitizeSummaryUnits(pre);
}

/**
 * Cleaning may join caption fragments into large context blocks so a thought is
 * not lost at a cue boundary. Ranking needs a different granularity: concise,
 * non-overlapping candidates that can be emitted as readable bullets.
 */
function prepareRankingUnits(units: string[]): string[] {
	return sanitizeSummaryUnits(
		splitLongUnitsForEmbed(
			units,
			RANKING_UNIT_SPLIT_THRESHOLD,
			RANKING_UNIT_CHUNK_CHARS,
			0,
		),
	);
}

/**
 * Unitize for LexRank/E5: prefer caption lines / sentence split (not soft-shred).
 */
function splitContentUnits(text: string): string[] {
	const normalized = text.replace(/^#{1,6}\s+/gm, "").trim();
	if (!normalized) return [];
	// Keep newlines so splitIntoSentences can line-merge cues.
	const lineCount = (normalized.match(/\n+/g) ?? []).length;
	if (lineCount >= 3) {
		return prepareRankingUnits(splitIntoSentences(normalized));
	}
	const { flatBody } = mergeLinesToText(normalized);
	const body = (flatBody || normalized.replace(/\n+/g, " ")).replace(/\s+/g, " ").trim();
	return prepareRankingUnits(splitIntoSentences(body));
}

/**
 * Stage 3 debug: units after sentence split + sanitize (what LexRank/E5 actually sees).
 */
export function formatRankingUnitsDebug(
	text: string,
	options: BuildScopesOptions = {},
): string {
	const scopes = buildSummaryScopes(text, options);
	const lines: string[] = [];
	for (const scope of scopes) {
		const units =
			scope.units.length > 0 ? scope.units : splitContentUnits(scope.text || text);
		if (scope.title) {
			lines.push(`[${scope.title}]`);
		}
		if (units.length === 0) {
			lines.push("(no units survived sanitize in this scope)");
			continue;
		}
		for (let i = 0; i < units.length; i += 1) {
			lines.push(`${i + 1}. ${units[i]}`);
		}
	}
	if (lines.length === 0) {
		return "(no units survived sanitize)";
	}
	return lines.join("\n");
}

function splitIntoNamedSections(text: string): TextSection[] {
	const { headers } = mergeLinesToText(text);
	if (headers.length === 0) {
		return [{ title: "", units: splitContentUnits(text) }];
	}

	const named = headers.filter((h) => h.title);
	// Single episode header still counts.
	if (named.length < 1) {
		return [{ title: "", units: splitContentUnits(text) }];
	}

	const sections: TextSection[] = [];
	for (const block of headers) {
		if (!block.title && !block.body) continue;
		const units = block.body
			? prepareRankingUnits(splitIntoSentences(block.body))
			: [];
		if (units.length === 0 && !block.title) continue;
		sections.push({ title: block.title, units });
	}

	const withUnits = sections.filter((s) => s.units.length > 0);
	if (withUnits.length === 0) {
		return [{ title: "", units: splitContentUnits(text) }];
	}
	return withUnits;
}

function selectSections(
	sections: TextSection[],
	maxSections: number,
): TextSection[] {
	if (sections.length <= maxSections) return sections;
	const picked: TextSection[] = [sections[0]];
	const rest = sections.slice(1);
	const slots = maxSections - 1;
	for (let i = 0; i < slots; i += 1) {
		const idx = Math.round((i * (rest.length - 1)) / Math.max(slots - 1, 1));
		const section = rest[idx];
		if (section && !picked.includes(section)) picked.push(section);
	}
	const order = new Map(sections.map((s, i) => [s, i]));
	return picked.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

function takeFirstSegmentUnits(
	units: string[],
	maxChars: number,
	maxUnits: number,
): string[] {
	const first: string[] = [];
	let chars = 0;
	for (const unit of units) {
		if (first.length >= maxUnits) break;
		if (chars > 0 && chars + unit.length > maxChars) break;
		first.push(unit);
		chars += unit.length + 1;
	}
	return first.length > 0 ? first : units.slice(0, Math.min(units.length, 8));
}

/**
 * Split cleaned transcript into independent summary scopes.
 * - Named episodes/parts: one scope each (capped); never mix across episodes.
 * - No headers (default): only the chronological **start** of the text.
 * - fullOutline without headers: several chronological windows (opt-in).
 */
export function buildSummaryScopes(
	text: string,
	options: BuildScopesOptions = {},
): SummaryScope[] {
	const fullOutline = options.fullOutline === true;
	const maxNamed = options.maxNamedScopes ?? MAX_NAMED_SECTIONS;
	const firstMaxChars = options.firstSegmentMaxChars ?? FIRST_SEGMENT_MAX_CHARS;
	const firstMaxUnits = options.firstSegmentMaxUnits ?? FIRST_SEGMENT_MAX_UNITS;

	const normalized = text.replace(/^#{1,6}\s+/gm, "").trim();
	if (!normalized) {
		return [{ title: "", text: "", units: [] }];
	}

	const sections = splitIntoNamedSections(normalized);
	const named = sections.filter((s) => s.title && s.units.length > 0);

	if (named.length >= 1) {
		const chosen = selectSections(named, maxNamed);
		return chosen.map((section) => ({
			title: section.title,
			text: section.units.join(" "),
			units: section.units,
		}));
	}

	const allUnits = splitContentUnits(normalized);
	if (allUnits.length === 0) {
		return [{ title: "", text: normalized, units: [] }];
	}

	// Default product rule: notes cover the start of the video only.
	if (!fullOutline) {
		const units = takeFirstSegmentUnits(allUnits, firstMaxChars, firstMaxUnits);
		return [
			{
				title: "",
				text: units.join(" "),
				units,
			},
		];
	}

	// Full outline: chronological windows covering start → end (even sample includes last).
	// Short transcripts stay one scope (all units) so ranking sees the whole arc.
	if (allUnits.length <= MAP_CHUNK_SENTENCES * 2) {
		return [
			{
				title: "",
				text: allUnits.join(" "),
				units: allUnits,
			},
		];
	}

	const windows = chunkSentences(allUnits, MAP_CHUNK_SENTENCES);
	const unique = pickEvenWindowIndexes(windows.length, MAX_CHRONO_WINDOWS);
	return unique.map((windowIndex, display) => {
		const units = windows[windowIndex] ?? [];
		return {
			title:
				unique.length >= 2
					? `Part ${display + 1}/${unique.length}`
					: "",
			text: units.join(" "),
			units,
		};
	});
}

function sentenceSimilarity(left: string[], right: string[]): number {
	if (left.length === 0 || right.length === 0) return 0;
	const rightSet = new Set(right);
	let overlap = 0;
	const leftSet = new Set(left);
	for (const word of leftSet) {
		if (rightSet.has(word)) overlap += 1;
	}
	if (overlap === 0) return 0;
	return overlap / (Math.log(1 + left.length) + Math.log(1 + right.length));
}

function addCoverageCandidate(
	selected: RankedSentence[],
	candidate: RankedSentence,
	infoScores: number[],
	topK: number,
	protectedIndex: number,
	totalUnits: number,
): void {
	if (selected.length < topK) {
		selected.push(candidate);
		return;
	}

	const thirdFor = (index: number) =>
		Math.min(2, Math.floor((index * 3) / Math.max(totalUnits, 1)));
	const counts = [0, 0, 0];
	for (const item of selected) counts[thirdFor(item.index)] += 1;

	let replaceIndex = -1;
	let weakestScore = Number.POSITIVE_INFINITY;
	for (let i = 0; i < selected.length; i += 1) {
		const item = selected[i];
		if (item.index === protectedIndex || counts[thirdFor(item.index)] <= 1) continue;
		const score = infoScores[item.index] ?? 0;
		if (score < weakestScore) {
			weakestScore = score;
			replaceIndex = i;
		}
	}
	if (replaceIndex >= 0) selected[replaceIndex] = candidate;
}

export function rankSentencesTextRank(
	sentences: string[],
	topK: number,
): RankedSentence[] {
	const n = sentences.length;
	if (n === 0) return [];
	if (n === 1) {
		const only = normalizePoint(sentences[0]);
		// Single unit: still allow ranking; emit gate is formatProcessedBullets.
		return [{ index: 0, sentence: only, score: 1 }];
	}

	const tokens = sentences.map((sentence) => tokenize(sentence));
	const scores = new Array(n).fill(1 / n);
	const strength = new Array(n).fill(0);
	const neighbors: number[][] = Array.from({ length: n }, () => []);
	const infoScores = sentences.map((s) => unitInfoScore(s));

	for (let i = 0; i < n; i += 1) {
		for (let j = i + 1; j < n; j += 1) {
			const sim = sentenceSimilarity(tokens[i], tokens[j]);
			if (sim < SIMILARITY_EDGE_MIN) continue;
			neighbors[i].push(j);
			neighbors[j].push(i);
			strength[i] += sim;
			strength[j] += sim;
		}
	}

	const weights: Array<Map<number, number>> = Array.from(
		{ length: n },
		() => new Map(),
	);
	for (let i = 0; i < n; i += 1) {
		for (const j of neighbors[i]) {
			if (j <= i) continue;
			const sim = sentenceSimilarity(tokens[i], tokens[j]);
			weights[i].set(j, sim);
			weights[j].set(i, sim);
		}
	}

	for (let iter = 0; iter < TEXTRANK_ITERATIONS; iter += 1) {
		const next = new Array(n).fill(0);
		for (let i = 0; i < n; i += 1) {
			let inbound = 0;
			for (const [j, weight] of weights[i]) {
				const denom = strength[j] || 1;
				inbound += (weight / denom) * scores[j];
			}
			next[i] = (1 - TEXTRANK_DAMPING) / n + TEXTRANK_DAMPING * inbound;
		}
		for (let i = 0; i < n; i += 1) scores[i] = next[i];
	}

	const ranked: RankedSentence[] = sentences.map((sentence, index) => ({
		index,
		sentence: normalizePoint(sentence),
		score: scores[index],
	}));
	ranked.sort((a, b) => b.score - a.score);

	// Prefer best eligible unit among first 8 (question / thesis block) — parity with E5 path.
	const headBound = Math.min(n, 8);
	let forcedHead: RankedSentence | null = null;
	let bestHeadScore = Number.NEGATIVE_INFINITY;
	for (const candidate of ranked) {
		if (candidate.index >= headBound) continue;
		if (!isBulletEligible(candidate.sentence)) continue;
		const lower = candidate.sentence.toLocaleLowerCase();
		const glueBoost =
			hasThesisGlue(lower) ? 0.3 : 0;
		const score = (infoScores[candidate.index] ?? 0) + glueBoost;
		if (score > bestHeadScore) {
			bestHeadScore = score;
			forcedHead = candidate;
		}
	}

	// Select only bullet-eligible units (mid-phrase crumbs never enter output pool).
	const eligibleRanked = ranked.filter((r) => isBulletEligible(r.sentence));
	// Prefer eligible; if almost none, allow non-hard-drop units that are not mid-phrase openers.
	const selectionPool =
		eligibleRanked.length >= 1
			? eligibleRanked
			: ranked.filter(
					(r) =>
						!isHardDropUnit(r.sentence) && !startsMidPhraseOpener(r.sentence),
				);

	const selected: RankedSentence[] = [];
	const remaining = [...selectionPool];
	const maxScore = ranked[0]?.score || 1;

	if (forcedHead && remaining.some((r) => r.index === forcedHead?.index)) {
		selected.push(forcedHead);
		const idx = remaining.findIndex((r) => r.index === forcedHead?.index);
		if (idx >= 0) remaining.splice(idx, 1);
	}

	while (selected.length < topK && remaining.length > 0) {
		let bestIdx = 0;
		let bestValue = Number.NEGATIVE_INFINITY;
		for (let r = 0; r < remaining.length; r += 1) {
			const candidate = remaining[r];
			const lexRel = candidate.score / maxScore;
			const infoRel = infoScores[candidate.index] ?? 0.3;
			let relevance = 0.65 * lexRel + 0.35 * infoRel;
			// Mild position penalty: later monologue digressions rank lower.
			relevance -= 0.05 * (candidate.index / Math.max(n - 1, 1));
			let maxSimToSelected = 0;
			for (const picked of selected) {
				const sim = sentenceSimilarity(
					tokens[candidate.index],
					tokens[picked.index],
				);
				if (sim > maxSimToSelected) maxSimToSelected = sim;
			}
			const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSimToSelected;
			if (mmr > bestValue) {
				bestValue = mmr;
				bestIdx = r;
			}
		}
		selected.push(remaining[bestIdx]);
		remaining.splice(bestIdx, 1);
	}

	// Breadth: early / middle / late thirds (info score only — no domain keywords).
	const thirds = [
		{ lo: 0, hi: Math.ceil(n / 3) },
		{ lo: Math.ceil(n / 3), hi: Math.ceil((2 * n) / 3) },
		{ lo: Math.ceil((2 * n) / 3), hi: n },
	];
	for (const { lo, hi } of thirds) {
		const covered = selected.some((s) => s.index >= lo && s.index < hi);
		if (covered) continue;
		let best: RankedSentence | null = null;
		let bestSc = -1;
		for (const r of eligibleRanked) {
			if (r.index < lo || r.index >= hi) continue;
			if (selected.some((s) => s.index === r.index)) continue;
			const sc = infoScores[r.index] ?? 0;
			if (sc > bestSc) {
				bestSc = sc;
				best = r;
			}
		}
		if (best) {
			addCoverageCandidate(
				selected,
				best,
				infoScores,
				topK,
				forcedHead?.index ?? -1,
				n,
			);
		}
	}

	// Floor: fill to MIN_SUMMARY_BULLETS by info among eligible (never mid-phrase).
	if (selected.length < MIN_SUMMARY_BULLETS) {
		const byInfo = [...eligibleRanked].sort(
			(a, b) => (infoScores[b.index] ?? 0) - (infoScores[a.index] ?? 0),
		);
		for (const extra of byInfo) {
			if (selected.some((s) => s.index === extra.index)) continue;
			selected.push(extra);
			if (selected.length >= Math.min(topK, MIN_SUMMARY_BULLETS + 1)) break;
		}
	}

	return stitchIncompleteSelected(
		selected.sort((a, b) => a.index - b.index),
	);
}

function chunkSentences(sentences: string[], chunkSize: number): string[][] {
	if (sentences.length <= chunkSize) return [sentences];
	const chunks: string[][] = [];
	for (let i = 0; i < sentences.length; i += chunkSize) {
		chunks.push(sentences.slice(i, i + chunkSize));
	}
	return chunks;
}

function summarizeUnitWindow(units: string[], topK: number): RankedSentence[] {
	if (units.length === 0) return [];
	let working = units;
	if (working.length > TEXTRANK_MAX_SENTENCES) {
		const step = working.length / TEXTRANK_MAX_SENTENCES;
		working = Array.from({ length: TEXTRANK_MAX_SENTENCES }, (_, i) => {
			return units[Math.min(units.length - 1, Math.floor(i * step))];
		});
	}
	return rankSentencesTextRank(working, topK);
}

/**
 * Split dirty ASR into question / answer discourse blocks (no domain keywords).
 * Uses answer-turn markers so mid/late material is ranked separately.
 */
export function splitDiscourseBlocks(text: string): Array<{ title: string; text: string }> {
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (!normalized) return [];
	const lines = normalized
		.split(/\n+/)
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const pieces: string[] = [];
	for (const line of lines.length > 0 ? lines : [normalized.replace(/\n+/g, " ")]) {
		const answer = line.match(ANSWER_TURN_RE);
		if (answer?.index && answer.index > 40) {
			pieces.push(line.slice(0, answer.index).trim());
			pieces.push(line.slice(answer.index).trim());
		} else {
			pieces.push(line);
		}
	}
	// Group: everything before first answer-turn marker = question; rest = answer.
	let answerAt = -1;
	for (let i = 0; i < pieces.length; i += 1) {
		if (ANSWER_TURN_RE.test(pieces[i])) {
			answerAt = i;
			break;
		}
	}
	if (answerAt <= 0) {
		return [{ title: "", text: pieces.join("\n") }];
	}
	const question = pieces.slice(0, answerAt).join("\n").trim();
	const answer = pieces.slice(answerAt).join("\n").trim();
	const blocks: Array<{ title: string; text: string }> = [];
	if (question.length >= 80) blocks.push({ title: "", text: question });
	if (answer.length >= 80) blocks.push({ title: "", text: answer });
	// Split long answer into chronological halves so closing is covered.
	if (blocks.length >= 1) {
		const last = blocks[blocks.length - 1];
		const units = splitContentUnits(last.text);
		if (units.length >= 12) {
			const mid = Math.floor(units.length / 2);
			blocks[blocks.length - 1] = {
				title: "",
				text: units.slice(0, mid).join("\n"),
			};
			blocks.push({ title: "", text: units.slice(mid).join("\n") });
		}
	}
	return blocks.length > 0 ? blocks : [{ title: "", text: normalized }];
}

/** Drop invalid bullets; keep complete thesis lines only. */
export function validateSummaryOutput(
	markdown: string,
	tuning: SummaryTuningOptions = {},
): string {
	const t = resolveTuning(tuning);
	const lines = markdown.split(/\n+/).map((l) => l.trim()).filter(Boolean);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		if (line.startsWith("##")) {
			out.push(line);
			continue;
		}
		const body = line.replace(/^[-*•]\s+/, "").trim();
		const clipped = truncateAtClauseBoundary(body, t.maxBulletChars);
		if (!validateSummaryBullet(clipped)) continue;
		const key = clipped.toLocaleLowerCase().slice(0, 64);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(`- ${clipped}`);
	}
	return out.join("\n");
}

/**
 * Scope-aware extractive outline (TextRank).
 * fullOutline=true: discourse blocks + chrono coverage (usable when WASM models abort).
 */
export function createExtractiveSummary(
	text: string,
	options: BuildScopesOptions = {},
): string {
	const fullOutline = options.fullOutline === true;
	const tuning = resolveTuning(options);
	const sourceChars = text.replace(/\s+/g, " ").trim().length;
	// Prefer discourse Q/A blocks on full video so late conclusions are ranked.
	const blockTexts =
		fullOutline && text.length >= 400
			? splitDiscourseBlocks(text)
			: [{ title: "", text }];

	const lines: string[] = [];
	let totalUnitsEstimate = 0;
	const poolUnits: string[] = [];

	for (const block of blockTexts) {
		const scopes = buildSummaryScopes(block.text, {
			...options,
			fullOutline,
		});
		for (const scope of scopes) {
			const units =
				scope.units.length > 0 ? scope.units : splitContentUnits(scope.text);
			if (units.length === 0) continue;
			totalUnitsEstimate += units.length;
			poolUnits.push(...units);
			const globalTarget = targetBulletCount(
				Math.max(totalUnitsEstimate, 1),
				fullOutline,
				sourceChars,
				tuning,
			);
			const topK = fullOutline
				? Math.min(
						Math.max(4, Math.ceil(globalTarget / 2)),
						Math.max(
							2,
							Math.ceil(units.length / 6),
						),
					)
				: scopes.length === 1
					? TEXTRANK_TOP_K
					: Math.min(
							SECTION_TOP_K,
							Math.max(2, Math.ceil(units.length / 20)),
						);
			let working = units;
			if (fullOutline && units.length > TEXTRANK_MAX_SENTENCES) {
				working = subsampleUnitsBalanced(units, TEXTRANK_MAX_SENTENCES);
			} else if (units.length > TEXTRANK_MAX_SENTENCES) {
				working = subsampleUnitsHeadHeavy(units, TEXTRANK_MAX_SENTENCES);
			}
			// Prefer complete thoughts for ranking window.
			working = working
				.map((u) => truncateAtClauseBoundary(u, tuning.maxBulletChars))
				.filter((u) => u.length >= 40 && !isIncompleteThought(u));
			if (working.length < 2) {
				working = units.filter((u) => isBulletEligible(u));
			}
			const ranked = summarizeUnitWindow(working, topK);
			if (ranked.length === 0) continue;
			if (scope.title && scopes.length >= 2) lines.push(`## ${scope.title}`);
			lines.push(...formatProcessedBullets(ranked, tuning));
		}
	}

	const globalTarget = targetBulletCount(
		Math.max(totalUnitsEstimate, 1),
		fullOutline,
		sourceChars,
		tuning,
	);
	let joined = lines.join("\n");
	joined = validateSummaryOutput(joined, tuning);
	if (joined) {
		const bullets = joined.split("\n").filter((l) => l.startsWith("-"));
		if (fullOutline && bullets.length > globalTarget) {
			joined = subsampleUnitsKeepEnds(bullets, globalTarget).join("\n");
		}
		joined = fitSummaryToCharBudget(joined, text, poolUnits, tuning, fullOutline);
		if (
			joined.split("\n").filter((l) => l.startsWith("-")).length >= tuning.minBullets ||
			summaryBodyChars(joined) > 0
		) {
			return joined || validateSummaryOutput(lines.join("\n"), tuning);
		}
	}

	// Last resort: best complete eligible units across whole text.
	const fallbackUnits = splitContentUnits(text)
		.map((u) => truncateAtClauseBoundary(u, tuning.maxBulletChars))
		.filter((u) => validateSummaryBullet(u));
	if (fallbackUnits.length > 0) {
		const byInfo = [...fallbackUnits].sort(
			(a, b) => unitInfoScore(b) - unitInfoScore(a),
		);
		const pickN = Math.min(
			globalTarget,
			Math.max(tuning.minBullets, byInfo.length),
		);
		// Keep chrono order among top-info picks for full outline (preserve last).
		const picked = fullOutline
			? subsampleUnitsKeepEnds(
					fallbackUnits.filter((u) =>
						byInfo.slice(0, Math.min(pickN + 4, byInfo.length)).includes(u),
					),
					pickN,
				)
			: byInfo.slice(0, tuning.minBullets);
		const out = fitSummaryToCharBudget(
			picked.map((u) => `- ${u}`).join("\n"),
			text,
			fallbackUnits,
			tuning,
			fullOutline,
		);
		if (out) return out;
	}
	const normalized = normalizePoint(text);
	return normalized ? `- ${normalized}` : "- No summary content was found.";
}

function isPrimarilyEnglish(text: string): boolean {
	const letters = text.match(/\p{L}/gu) ?? [];
	if (letters.length === 0) return false;
	const latinLetters = text.match(/[A-Za-z]/g) ?? [];
	return latinLetters.length / letters.length >= 0.85;
}

function handleModelProgress(info: ProgressInfo, label: string): void {
	if (info.status === "ready") {
		updateState({
			status: "ready",
			progress: 100,
			detail: `${label} ready`,
		});
		return;
	}
	const progress =
		typeof info.progress === "number"
			? Math.max(0, Math.min(100, Math.round(info.progress)))
			: localState.progress;
	updateState({
		status: "loading",
		progress,
		detail: `Downloading ${label}…`,
	});
}

async function bootstrapTransformersEnv(): Promise<void> {
	await import("../ort-env-bootstrap");
	const { env } = await import("@huggingface/transformers");
	env.allowLocalModels = false;
	env.useBrowserCache = true;
}

async function loadEnSummarizationPipeline(): Promise<GenericPipeline> {
	if (enModelUnavailable) {
		throw new Error("English summarization model unavailable");
	}
	if (!enPipelinePromise) {
		updateState({
			status: "loading",
			progress: 0,
			detail: "Loading English summarization model…",
		});
		enPipelinePromise = (async () => {
			await bootstrapTransformersEnv();
			const { pipeline } = await import("@huggingface/transformers");
			const summarizer = await pipeline(
				"summarization",
				EN_SUMMARIZATION_MODEL,
				{
					dtype: "q8",
					device: "wasm",
					progress_callback: (info: ProgressInfo) =>
						handleModelProgress(info, "English summarization model"),
				},
			);
			updateState({
				status: "ready",
				progress: 100,
				detail: "English summarization model ready",
			});
			return summarizer as GenericPipeline;
		})().catch((error) => {
			enPipelinePromise = null;
			enModelUnavailable = true;
			throw error;
		});
	}
	return enPipelinePromise;
}

async function loadRuSummarizationPipeline(): Promise<GenericPipeline> {
	if (ruModelUnavailable) {
		throw new Error("Russian summarization model unavailable");
	}
	if (!ruPipelinePromise) {
		updateState({
			status: "loading",
			progress: 0,
			detail: "Loading Russian summarization model…",
		});
		ruPipelinePromise = (async () => {
			await bootstrapTransformersEnv();
			const { pipeline } = await import("@huggingface/transformers");
			const summarizer = await pipeline(
				"summarization",
				RU_SUMMARIZATION_MODEL,
				{
					dtype: "q4",
					device: "wasm",
					progress_callback: (info: ProgressInfo) =>
						handleModelProgress(info, "Russian summarization model"),
				},
			);
			updateState({
				status: "ready",
				progress: 100,
				detail: "Russian summarization model ready",
			});
			return summarizer as GenericPipeline;
		})().catch((error) => {
			ruPipelinePromise = null;
			ruModelUnavailable = true;
			throw error;
		});
	}
	return ruPipelinePromise;
}

function releaseQwenPipelinesExcept(keep?: QwenSummaryModel): void {
	for (const model of ["balanced", "quality"] as const) {
		if (model === keep) continue;
		const pending = qwenPipelinePromises[model];
		if (!pending) continue;
		delete qwenPipelinePromises[model];
		void pending
			.then((pipeline) => pipeline.dispose?.())
			.catch(() => undefined);
	}
}

/** Dispose cached local ONNX pipelines (user cleanup). Next run re-downloads/loads. */
export async function releaseLocalAiCaches(): Promise<void> {
	releaseQwenPipelinesExcept();
	const disposePending = async (
		pending: Promise<{ dispose?: () => void | Promise<void> }> | null,
	) => {
		if (!pending) return;
		try {
			const pipe = await pending.catch(() => null);
			await pipe?.dispose?.();
		} catch {
			// ignore
		}
	};
	await disposePending(embedPipelinePromise);
	embedPipelinePromise = null;
	embedModelUnavailable = false;
	await disposePending(enPipelinePromise);
	enPipelinePromise = null;
	enModelUnavailable = false;
	await disposePending(ruPipelinePromise);
	ruPipelinePromise = null;
	ruModelUnavailable = false;
	updateState({
		status: "idle",
		progress: 0,
		detail: "Local model caches cleared",
	});
}

function qwenModelDetails(model: QwenSummaryModel): { id: string; label: string } {
	return model === "quality"
		? { id: QWEN_QUALITY_MODEL, label: "Qwen3 1.7B" }
		: { id: QWEN_BALANCED_MODEL, label: "Qwen3 0.6B" };
}

const qwenAbortRetries = new Map<QwenSummaryModel, number>();

function isTransientModelError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return /abort|aborted|oom|out of memory|memory|Failed to fetch|network/i.test(
		msg,
	);
}

async function loadQwenPipeline(model: QwenSummaryModel): Promise<GenericPipeline> {
	if (qwenModelUnavailable.has(model)) {
		throw new Error(`${qwenModelDetails(model).label} is unavailable`);
	}
	// Free other Qwen sizes before loading (MV3 memory).
	releaseQwenPipelinesExcept(model);
	// Also drop E5 while a large generative model is loading.
	if (embedPipelinePromise) {
		try {
			const embed = await embedPipelinePromise.catch(() => null);
			await embed?.dispose?.();
		} catch {
			// ignore
		}
		embedPipelinePromise = null;
	}
	await new Promise((r) => setTimeout(r, 0));

	const pending = qwenPipelinePromises[model];
	if (pending) return pending;

	const details = qwenModelDetails(model);
	updateState({
		status: "loading",
		progress: 0,
		detail: `Loading ${details.label}…`,
	});

	const promise = (async () => {
		await bootstrapTransformersEnv();
		const { pipeline } = await import("@huggingface/transformers");
		const create = async (device: "webgpu" | "wasm", dtype: "q4f16" | "q4") => {
			const generator = await pipeline("text-generation", details.id, {
				device,
				dtype,
				progress_callback: (info: ProgressInfo) =>
					handleModelProgress(info, details.label),
			});
			return generator as GenericPipeline;
		};

		const supportsWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
		let generator: GenericPipeline;
		if (supportsWebGpu) {
			try {
				generator = await create("webgpu", "q4f16");
			} catch (error) {
				// Quality may still work on WASM q4 on some devices; try once.
				console.warn(
					`[LocalAI] ${details.label} WebGPU load failed; trying WASM:`,
					error,
				);
				generator = await create("wasm", "q4");
			}
		} else {
			generator = await create("wasm", "q4");
		}

		updateState({
			status: "ready",
			progress: 100,
			detail: `${details.label} ready`,
		});
		return generator;
	})().catch((error) => {
		delete qwenPipelinePromises[model];
		const retries = qwenAbortRetries.get(model) ?? 0;
		if (isTransientModelError(error) && retries < 1) {
			qwenAbortRetries.set(model, retries + 1);
			// Allow one more cold-load after abort (do not permanent-blacklist yet).
		} else {
			qwenModelUnavailable.add(model);
		}
		throw error;
	});

	qwenPipelinePromises[model] = promise;
	return promise;
}

async function loadEmbedPipeline(): Promise<FeaturePipeline> {
	if (embedModelUnavailable) {
		throw new Error("Multilingual embedding model unavailable");
	}
	if (!embedPipelinePromise) {
		updateState({
			status: "loading",
			progress: 0,
			detail: "Loading multilingual E5 embeddings…",
		});
		embedPipelinePromise = (async () => {
			await bootstrapTransformersEnv();
			const { pipeline } = await import("@huggingface/transformers");
			const extractor = await pipeline(
				"feature-extraction",
				MULTI_EMBED_MODEL,
				{
					dtype: "q8",
					device: "wasm",
					progress_callback: (info: ProgressInfo) =>
						handleModelProgress(info, "multilingual E5 model"),
				},
			);
			updateState({
				status: "ready",
				progress: 100,
				detail: "Multilingual E5 model ready",
			});
			return extractor as FeaturePipeline;
		})().catch((error) => {
			embedPipelinePromise = null;
			embedModelUnavailable = true;
			throw error;
		});
	}
	return embedPipelinePromise;
}

function extractGeneratedText(
	result: SummarizationResult | SummarizationResult[],
): string {
	const first = Array.isArray(result) ? result[0] : result;
	const generated = first?.summary_text ?? first?.generated_text ?? "";
	if (typeof generated === "string") return generated.trim();
	return generated[generated.length - 1]?.content?.trim() ?? "";
}

function isUsableSummaryText(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length < 12) return false;
	if (/<extra_id_\d+>/i.test(trimmed)) return false;
	if (/^[\s\-–—*•.]+$/.test(trimmed)) return false;
	return (trimmed.match(/[\p{L}]/gu) ?? []).length >= 8;
}

function toVector(data: Float32Array | number[]): number[] {
	return Array.from(data);
}

function cosine(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let sum = 0;
	for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
	return sum;
}

function subsampleUnits(units: string[], maxUnits: number): string[] {
	if (units.length <= maxUnits) return units;
	const step = units.length / maxUnits;
	return Array.from({ length: maxUnits }, (_, i) => {
		return units[Math.min(units.length - 1, Math.floor(i * step))];
	});
}

/**
 * Cap a chrono list while always keeping the first and last items (full-outline).
 */
function subsampleUnitsKeepEnds(units: string[], maxUnits: number): string[] {
	if (units.length <= maxUnits) return units;
	if (maxUnits <= 1) return [units[units.length - 1] ?? units[0]].filter(Boolean);
	if (maxUnits === 2) return [units[0], units[units.length - 1]];
	const indexes = pickEvenWindowIndexes(units.length, maxUnits);
	return indexes.map((i) => units[i]).filter(Boolean);
}

/**
 * Prefer early units (intro) when capping for embeddings, then sample the rest.
 * Used when fullOutline is false (first-segment notes).
 */
function subsampleUnitsHeadHeavy(units: string[], maxUnits: number): string[] {
	if (units.length <= maxUnits) return units;
	const headCount = Math.min(Math.floor(maxUnits * 0.45), units.length);
	const head = units.slice(0, headCount);
	const restBudget = maxUnits - head.length;
	if (restBudget <= 0) return head;
	const rest = units.slice(headCount);
	const sampledRest = subsampleUnits(rest, restBudget);
	return [...head, ...sampledRest];
}

/**
 * Balanced head / mid / tail sample for full-transcript coverage.
 * ~25% head, ~50% middle, ~25% tail (even steps within each band).
 */
function subsampleUnitsBalanced(units: string[], maxUnits: number): string[] {
	if (units.length <= maxUnits) return units;
	const n = units.length;
	const headN = Math.max(1, Math.floor(maxUnits * 0.25));
	const tailN = Math.max(1, Math.floor(maxUnits * 0.25));
	const midN = Math.max(1, maxUnits - headN - tailN);
	const headEnd = Math.max(headN, Math.floor(n * 0.25));
	const tailStart = Math.min(n - tailN, Math.floor(n * 0.75));
	const head = units.slice(0, headEnd);
	const mid = units.slice(headEnd, tailStart);
	const tail = units.slice(tailStart);
	const picked = [
		...subsampleUnits(head, headN),
		...subsampleUnits(mid, midN),
		...subsampleUnits(tail, tailN),
	];
	// Dedupe while preserving order (band edges can overlap on short mid).
	const seen = new Set<string>();
	const out: string[] = [];
	for (const u of picked) {
		const key = u.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(u);
		if (out.length >= maxUnits) break;
	}
	return out;
}

const GREETING_UNIT_RE =
	/хочу\s+выразить|хочу\s+вам\s+поклон|великое\s+почтение|добрый\s+(?:день|вечер)|здравствуй/iu;

function isGreetingHeavyUnit(text: string): boolean {
	return GREETING_UNIT_RE.test(text);
}

/**
 * Fallback topic string: page/video title + early non-greeting content units.
 */
export function buildTopicQueryText(
	units: string[],
	scopeTitle = "",
	maxChars = TOPIC_QUERY_MAX_CHARS,
	topicHint = "",
): string {
	const parts: string[] = [];
	const hint = topicHint.replace(/^#+\s*/, "").trim();
	if (hint) parts.push(hint);
	const title = scopeTitle.replace(/^#+\s*/, "").trim();
	if (title && !/^(part|section)\s*\d+/i.test(title) && title !== hint) {
		parts.push(title);
	}
	let added = 0;
	for (const unit of units) {
		if (added >= 4) break;
		if (isGreetingHeavyUnit(unit)) continue;
		parts.push(unit);
		added += 1;
	}
	if (added === 0) {
		for (const unit of units.slice(0, 3)) {
			if (!isGreetingHeavyUnit(unit) || parts.length === 0) parts.push(unit);
		}
	}
	let joined = parts.join(" ").replace(/\s+/g, " ").trim();
	if (joined.length > maxChars) {
		joined = joined.slice(0, maxChars).replace(/\s+\S*$/u, "").trim();
	}
	return joined;
}

/**
 * Topic from top LexRank-central units among quality units + title hint.
 */
export function buildTopicQueryFromLexRank(
	units: string[],
	lexScores: number[],
	scopeTitle = "",
	topK = TOPIC_LEXRANK_TOP_K,
	maxChars = TOPIC_QUERY_MAX_CHARS,
	topicHint = "",
): string {
	if (units.length === 0 || lexScores.length !== units.length) {
		return buildTopicQueryText(units, scopeTitle, maxChars, topicHint);
	}

	const ranked = units
		.map((sentence, index) => ({
			index,
			sentence,
			score: lexScores[index] ?? 0,
			tokens: tokenizeWords(sentence).length,
		}))
		.filter((u) => u.tokens >= 8 && !isGreetingHeavyUnit(u.sentence))
		.sort((a, b) => b.score - a.score);

	const picked = ranked.slice(0, Math.min(topK, ranked.length));
	if (picked.length < 2) {
		return buildTopicQueryText(units, scopeTitle, maxChars, topicHint);
	}

	// Chronological join of central units (stable topic prose).
	picked.sort((a, b) => a.index - b.index);
	const parts: string[] = [];
	const hint = topicHint.replace(/^#+\s*/, "").trim();
	if (hint) parts.push(hint);
	const title = scopeTitle.replace(/^#+\s*/, "").trim();
	if (title && !/^(part|section)\s*\d+/i.test(title) && title !== hint) {
		parts.push(title);
	}
	for (const p of picked) parts.push(p.sentence);

	let joined = parts.join(" ").replace(/\s+/g, " ").trim();
	if (joined.length > maxChars) {
		joined = joined.slice(0, maxChars).replace(/\s+\S*$/u, "").trim();
	}
	return joined || buildTopicQueryText(units, scopeTitle, maxChars, topicHint);
}

/** PageRank-style centrality on passage–passage cosine graph. */
function computeLexRankScores(vectors: number[][]): number[] {
	const n = vectors.length;
	if (n === 0) return [];
	if (n === 1) return [1];

	const scores = new Array(n).fill(1 / n);
	const strength = new Array(n).fill(0);
	const weights: Array<Map<number, number>> = Array.from(
		{ length: n },
		() => new Map(),
	);

	for (let i = 0; i < n; i += 1) {
		for (let j = i + 1; j < n; j += 1) {
			const sim = cosine(vectors[i], vectors[j]);
			if (sim < LEXRANK_EDGE_MIN) continue;
			weights[i].set(j, sim);
			weights[j].set(i, sim);
			strength[i] += sim;
			strength[j] += sim;
		}
	}

	for (let i = 0; i < n; i += 1) {
		if (strength[i] === 0) {
			strength[i] = 1;
			weights[i].set(i, 1);
		}
	}

	for (let iter = 0; iter < TEXTRANK_ITERATIONS; iter += 1) {
		const next = new Array(n).fill(0);
		for (let i = 0; i < n; i += 1) {
			let inbound = 0;
			for (const [j, weight] of weights[i]) {
				if (j === i && weights[i].size === 1) {
					inbound += scores[j];
					continue;
				}
				const denom = strength[j] || 1;
				inbound += (weight / denom) * scores[j];
			}
			next[i] = (1 - TEXTRANK_DAMPING) / n + TEXTRANK_DAMPING * inbound;
		}
		for (let i = 0; i < n; i += 1) scores[i] = next[i];
	}

	return scores;
}

/**
 * LexRank on passage–passage cosine graph, then MMR with topic Q + info density.
 * relevance = 0.25·Lex + 0.50·Sim(Di,Q) + 0.25·info
 */
function rankUnitsLexRankEmbed(
	units: string[],
	vectors: number[][],
	topK: number,
	queryVector: number[] | null = null,
	lexScores?: number[],
): RankedSentence[] {
	const n = units.length;
	if (n === 0) return [];
	if (n === 1) {
		return [{ index: 0, sentence: normalizePoint(units[0]), score: 1 }];
	}

	const scores = lexScores ?? computeLexRankScores(vectors);
	const infoScores = units.map((u) => unitInfoScore(u));

	const ranked: RankedSentence[] = units.map((sentence, index) => ({
		index,
		sentence: normalizePoint(sentence),
		score: scores[index],
	}));
	ranked.sort((a, b) => b.score - a.score);

	// Topic similarity Sim(passage_i, Q) for asymmetric MMR relevance.
	const topicSims: number[] | null = queryVector
		? vectors.map((v) => cosine(v, queryVector))
		: null;
	let maxTopic = 1;
	if (topicSims) {
		maxTopic = Math.max(...topicSims.map((x) => Math.max(0, x)), 1e-6);
	}

	// Prefer best eligible unit among first 8 (question / thesis block).
	const headBound = Math.min(n, 8);
	let forcedHead: RankedSentence | null = null;
	let bestHeadScore = Number.NEGATIVE_INFINITY;
	for (const candidate of ranked) {
		if (candidate.index >= headBound) continue;
		if (!isBulletEligible(candidate.sentence)) continue;
		const lower = candidate.sentence.toLocaleLowerCase();
		const glueBoost =
			hasThesisGlue(lower) ? 0.3 : 0;
		const score = (infoScores[candidate.index] ?? 0) + glueBoost;
		if (score > bestHeadScore) {
			bestHeadScore = score;
			forcedHead = candidate;
		}
	}

	// Select only bullet-eligible units (mid-phrase crumbs stay out of output).
	const eligibleRanked = ranked.filter((r) => isBulletEligible(r.sentence));
	const selectionPool =
		eligibleRanked.length >= 1
			? eligibleRanked
			: ranked.filter(
					(r) =>
						!isHardDropUnit(r.sentence) && !startsMidPhraseOpener(r.sentence),
				);

	// MMR: λ·relevance − (1−λ)·max sim; mild penalty for later digressions.
	const selected: RankedSentence[] = [];
	const remaining = [...selectionPool];
	const maxScore = ranked[0]?.score || 1;

	if (forcedHead && remaining.some((r) => r.index === forcedHead?.index)) {
		selected.push(forcedHead);
		const idx = remaining.findIndex((r) => r.index === forcedHead?.index);
		if (idx >= 0) remaining.splice(idx, 1);
	}

	while (selected.length < topK && remaining.length > 0) {
		let bestIdx = 0;
		let bestValue = Number.NEGATIVE_INFINITY;
		for (let r = 0; r < remaining.length; r += 1) {
			const candidate = remaining[r];
			const lexRel = candidate.score / maxScore;
			const topicRel = topicSims
				? Math.max(0, topicSims[candidate.index]) / maxTopic
				: lexRel;
			const infoRel = infoScores[candidate.index] ?? 0.3;
			let relevance =
				topicSims === null
					? MMR_LEX_WEIGHT * lexRel +
						(MMR_TOPIC_WEIGHT + MMR_INFO_WEIGHT) * infoRel
					: MMR_LEX_WEIGHT * lexRel +
						MMR_TOPIC_WEIGHT * topicRel +
						MMR_INFO_WEIGHT * infoRel;
			// Mild position penalty: later monologue digressions rank lower.
			relevance -= 0.05 * (candidate.index / Math.max(n - 1, 1));
			let maxSim = 0;
			for (const picked of selected) {
				const sim = cosine(vectors[candidate.index], vectors[picked.index]);
				if (sim > maxSim) maxSim = sim;
			}
			const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
			if (mmr > bestValue) {
				bestValue = mmr;
				bestIdx = r;
			}
		}
		selected.push(remaining[bestIdx]);
		remaining.splice(bestIdx, 1);
	}

	// Breadth: early / middle / late thirds (info score only — no domain keywords).
	const thirds = [
		{ lo: 0, hi: Math.ceil(n / 3) },
		{ lo: Math.ceil(n / 3), hi: Math.ceil((2 * n) / 3) },
		{ lo: Math.ceil((2 * n) / 3), hi: n },
	];
	for (const { lo, hi } of thirds) {
		const covered = selected.some((s) => s.index >= lo && s.index < hi);
		if (covered) continue;
		let best: RankedSentence | null = null;
		let bestSc = -1;
		for (const r of eligibleRanked) {
			if (r.index < lo || r.index >= hi) continue;
			if (selected.some((s) => s.index === r.index)) continue;
			const sc = infoScores[r.index] ?? 0;
			if (sc > bestSc) {
				bestSc = sc;
				best = r;
			}
		}
		if (best) {
			addCoverageCandidate(
				selected,
				best,
				infoScores,
				topK,
				forcedHead?.index ?? -1,
				n,
			);
		}
	}

	// Floor: fill to MIN_SUMMARY_BULLETS by info among eligible.
	if (selected.length < MIN_SUMMARY_BULLETS) {
		const byInfo = [...eligibleRanked].sort(
			(a, b) => (infoScores[b.index] ?? 0) - (infoScores[a.index] ?? 0),
		);
		for (const extra of byInfo) {
			if (selected.some((s) => s.index === extra.index)) continue;
			selected.push(extra);
			if (selected.length >= Math.min(topK, MIN_SUMMARY_BULLETS + 1)) break;
		}
	}

	return stitchIncompleteSelected(
		selected.sort((a, b) => a.index - b.index),
	);
}

/**
 * Merge consecutive selected units when the earlier one ends mid-thought
 * (e.g. unit ending on intensifier + following continuation clause).
 */
function stitchIncompleteSelected(items: RankedSentence[]): RankedSentence[] {
	if (items.length <= 1) return items;
	const out: RankedSentence[] = [];
	for (const item of items) {
		const prev = out.length > 0 ? out[out.length - 1] : null;
		if (
			prev &&
			endsIncomplete(prev.sentence) &&
			prev.sentence.length + 1 + item.sentence.length <=
				MAX_OUTPUT_BULLET_CHARS
		) {
			out[out.length - 1] = {
				index: prev.index,
				sentence: normalizePoint(`${prev.sentence} ${item.sentence}`),
				score: Math.max(prev.score, item.score),
			};
			continue;
		}
		out.push(item);
	}
	return out;
}

/** Final polish: collapse residual loops, strip stage glitches + speech debris. */
function postProcessBullet(text: string): string {
	let s = normalizePoint(text);
	s = collapseAsrLoops(s);
	s = fixAsrGlitches(s);
	s = stripLeadingFillers(s);
	s = stripSpeechDebris(s);
	s = trimTrailingTopicJump(s);
	// Caption windows can end on a dangling discourse tail; keep the completed claim.
	s = s.replace(/\s+(?:это\s+очень|то\s+есть|потому\s+что)$/iu, "");
	s = s.replace(/\s+/g, " ").trim();
	s = s.replace(/^[:\-–—•.,;\s]+/u, "");
	if (s.length > 0 && /\p{Ll}/u.test(s[0])) {
		s = s[0].toLocaleUpperCase() + s.slice(1);
	}
	return s;
}

function formatProcessedBullets(
	items: RankedSentence[],
	tuning: SummaryTuningOptions = {},
): string[] {
	const t = resolveTuning(tuning);
	// Stitch incomplete halves that ranking still emitted as neighbors.
	const stitched = stitchIncompleteSelected(
		[...items].sort((a, b) => a.index - b.index),
	);

	const toBullet = (sentence: string, allowIncompleteLong = false): string | null => {
		let bullet = postProcessBullet(sentence);
		if (bullet.length < 18) return null;
		if ((bullet.match(/[\p{L}]/gu) ?? []).length < 12) return null;
		if (isGreetingHeavyUnit(bullet)) return null;
		// Soft-cap long units at clause boundary (never mid-NP hard chop).
		if (bullet.length > t.maxBulletChars) {
			bullet = truncateAtClauseBoundary(bullet, t.maxBulletChars);
		}
		if (!isBulletEligible(bullet)) return null;
		if (isIncompleteThought(bullet) && !allowIncompleteLong) return null;
		if (allowIncompleteLong && isIncompleteThought(bullet)) {
			// Long salvage only with real discourse glue (not bare «причин»).
			if (
				!(
					bullet.length >= 220 &&
					hasThesisGlue(bullet) &&
					!startsMidPhraseOpener(bullet)
				)
			) {
				return null;
			}
		}
		if (!validateSummaryBullet(bullet) && !allowIncompleteLong) return null;
		return bullet;
	};

	const lines: string[] = [];
	const seen = new Set<string>();
	for (const item of stitched) {
		const bullet = toBullet(item.sentence, false);
		if (!bullet) continue;
		const key = bullet.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		lines.push(`- ${bullet}`);
	}

	const preferred = Math.max(PREFERRED_SUMMARY_BULLETS, t.minBullets);
	// Soft fill toward preferred count with strict bullets only — never incomplete mush.
	if (lines.length < preferred) {
		const extras = [...stitched]
			.map((item) => ({
				item,
				bullet: toBullet(item.sentence, false),
				info: unitInfoScore(item.sentence),
			}))
			.filter((e) => e.bullet && !seen.has(e.bullet.toLocaleLowerCase()))
			.sort((a, b) => b.info - a.info);
		for (const extra of extras) {
			if (!extra.bullet) continue;
			seen.add(extra.bullet.toLocaleLowerCase());
			lines.push(`- ${extra.bullet}`);
			if (lines.length >= Math.min(preferred, TEXTRANK_TOP_K)) {
				break;
			}
		}
	}

	// Hard floor: allow incomplete-long salvage only if we have fewer than MIN complete.
	if (lines.length < t.minBullets) {
		const extras = [...stitched]
			.map((item) => ({
				item,
				bullet: toBullet(item.sentence, true),
				info: unitInfoScore(item.sentence),
			}))
			.filter((e) => e.bullet && !seen.has(e.bullet.toLocaleLowerCase()))
			.sort((a, b) => b.info - a.info);
		for (const extra of extras) {
			if (!extra.bullet) continue;
			seen.add(extra.bullet.toLocaleLowerCase());
			lines.push(`- ${extra.bullet}`);
			if (lines.length >= t.minBullets) break;
		}
	}

	return lines;
}

/**
 * Drop near-copies among E5 vectors (cos ≥ threshold within local window).
 * Keep the unit with higher unitInfoScore (not always the later one).
 */
function dropNearDuplicateUnits(
	units: string[],
	vectors: number[][],
	minCos = EMBED_NEAR_DUP_COS,
	window = EMBED_NEAR_DUP_WINDOW,
): { units: string[]; vectors: number[][] } {
	if (units.length !== vectors.length || units.length === 0) {
		return { units, vectors };
	}
	const keep: boolean[] = new Array(units.length).fill(true);
	const infos = units.map((u) => unitInfoScore(u));
	for (let i = 0; i < units.length; i += 1) {
		if (!keep[i]) continue;
		const end = Math.min(units.length, i + 1 + window);
		for (let j = i + 1; j < end; j += 1) {
			if (!keep[j]) continue;
			if (cosine(vectors[i], vectors[j]) < minCos) continue;
			// Keep higher-info unit; drop the weaker duplicate.
			if (infos[j] > infos[i]) {
				keep[i] = false;
				break;
			}
			keep[j] = false;
		}
	}
	const nextUnits: string[] = [];
	const nextVectors: number[][] = [];
	for (let i = 0; i < units.length; i += 1) {
		if (!keep[i]) continue;
		nextUnits.push(units[i]);
		nextVectors.push(vectors[i]);
	}
	return { units: nextUnits, vectors: nextVectors };
}

/**
 * Farthest-first medoids for multi-centroid topic Q (reuses E5 vectors).
 */
function selectClusterMedoidIndices(
	vectors: number[][],
	k: number,
): number[] {
	const n = vectors.length;
	if (n === 0) return [];
	if (n === 1) return [0];
	const targetK = Math.max(1, Math.min(k, n));

	// Seed: unit farthest from mean (or 0).
	const mean = new Array(vectors[0].length).fill(0);
	for (const v of vectors) {
		for (let d = 0; d < v.length; d += 1) mean[d] += v[d];
	}
	for (let d = 0; d < mean.length; d += 1) mean[d] /= n;

	let seed = 0;
	let seedDist = -1;
	for (let i = 0; i < n; i += 1) {
		const dist = 1 - cosine(vectors[i], mean);
		if (dist > seedDist) {
			seedDist = dist;
			seed = i;
		}
	}

	const medoids = [seed];
	while (medoids.length < targetK) {
		let bestI = -1;
		let bestMin = -1;
		for (let i = 0; i < n; i += 1) {
			if (medoids.includes(i)) continue;
			let minD = Number.POSITIVE_INFINITY;
			for (const m of medoids) {
				const d = 1 - cosine(vectors[i], vectors[m]);
				if (d < minD) minD = d;
			}
			if (minD > bestMin) {
				bestMin = minD;
				bestI = i;
			}
		}
		if (bestI < 0) break;
		medoids.push(bestI);
	}
	return medoids.sort((a, b) => a - b);
}

/**
 * Build topic query text from embedding medoids + title (Phase A multi-centroid Q).
 */
export function buildTopicQueryFromMedoids(
	units: string[],
	vectors: number[][],
	topicHint = "",
	scopeTitle = "",
	maxChars = TOPIC_QUERY_MAX_CHARS,
): string {
	if (units.length === 0 || vectors.length !== units.length) {
		return buildTopicQueryText(units, scopeTitle, maxChars, topicHint);
	}
	const k = Math.min(
		TOPIC_CLUSTER_MAX_K,
		Math.max(2, Math.floor(units.length / 5) + 1),
	);
	const medoidIdx = selectClusterMedoidIndices(vectors, k);
	const parts: string[] = [];
	const hint = topicHint.replace(/^#+\s*/, "").trim();
	if (hint) parts.push(hint);
	const title = scopeTitle.replace(/^#+\s*/, "").trim();
	if (title && title !== hint && !/^(part|section)\s*\d+/i.test(title)) {
		parts.push(title);
	}
	for (const i of medoidIdx) {
		const u = units[i];
		if (!u || isGreetingHeavyUnit(u) || !isBulletEligible(u)) continue;
		parts.push(u);
	}
	if (parts.length <= (hint ? 1 : 0)) {
		return buildTopicQueryText(units, scopeTitle, maxChars, topicHint);
	}
	let joined = parts.join(" ").replace(/\s+/g, " ").trim();
	if (joined.length > maxChars) {
		joined = joined.slice(0, maxChars).replace(/\s+\S*$/u, "").trim();
	}
	return joined;
}

/**
 * Multilingual AI extractive summary: E5 + LexRank + MMR **per scope**.
 * fullOutline=true (video): covers full transcript via chrono windows start→end.
 * fullOutline=false: first segment or named episodes only.
 */
export async function summarizeWithEmbeddings(
	text: string,
	options: BuildScopesOptions = {},
): Promise<string> {
	const topicHint = options.topicHint?.trim() ?? "";
	const fullOutline = options.fullOutline === true;
	const tuning = resolveTuning(options);
	const scopes = buildSummaryScopes(text, options);
	if (scopes.length === 0 || scopes.every((s) => s.units.length === 0 && !s.text)) {
		return createExtractiveSummary(text, options);
	}

	updateState({
		status: "summarizing",
		progress: 5,
		detail: fullOutline
			? "Running full-transcript E5 embeddings…"
			: "Running multilingual E5 embeddings…",
	});
	const extractor = await loadEmbedPipeline();

	const embedOne = async (
		text: string,
		prefix: string,
	): Promise<number[]> => {
		const out = await extractor(`${prefix}${text}`, {
			pooling: "mean",
			normalize: true,
		});
		return toVector(out.data);
	};

	const embedManyPassages = async (
		units: string[],
		scopeProgressBase: number,
		scopeProgressSpan: number,
	): Promise<number[][]> => {
		const vectors: number[][] = [];
		for (let i = 0; i < units.length; i += 1) {
			// E5 asymmetric: document units always "passage: ".
			vectors.push(await embedOne(units[i], E5_PASSAGE_PREFIX));
			if (i % 8 === 0) {
				const local = units.length ? i / units.length : 1;
				updateState({
					status: "summarizing",
					progress: Math.min(
						98,
						Math.round(scopeProgressBase + local * scopeProgressSpan * 0.9),
					),
					detail: `Embedding passages (${i + 1}/${units.length})…`,
				});
				await new Promise((r) => setTimeout(r, 0));
			}
		}
		return vectors;
	};

	const pickFromUnits = async (
		units: string[],
		topK: number,
		scopeProgressBase: number,
		scopeProgressSpan: number,
		scopeTitle = "",
	): Promise<RankedSentence[]> => {
		// Hard-drop only before embed; soft penalties applied via unitInfoScore.
		const qualityUnits = units.filter((u) => !isHardDropUnit(u));
		const baseUnits = qualityUnits.length >= 3 ? qualityUnits : units;
		// Long units → chunks before embed (E5 512-token safety).
		const chunked = splitLongUnitsForEmbed(baseUnits);
		const working = fullOutline
			? subsampleUnitsBalanced(chunked, EMBED_MAX_UNITS)
			: subsampleUnitsHeadHeavy(chunked, EMBED_MAX_UNITS);
		const rawVectors = await embedManyPassages(
			working,
			scopeProgressBase,
			scopeProgressSpan,
		);
		if (rawVectors.length === 0) return [];
		const deduped = dropNearDuplicateUnits(working, rawVectors);
		if (deduped.units.length === 0) return [];

		const lexScores = computeLexRankScores(deduped.vectors);
		// Multi-centroid Q on E5 vectors; fallback to LexRank-top if too few units.
		const topicText =
			deduped.units.length >= 8
				? buildTopicQueryFromMedoids(
						deduped.units,
						deduped.vectors,
						topicHint,
						scopeTitle,
					)
				: buildTopicQueryFromLexRank(
						deduped.units,
						lexScores,
						scopeTitle,
						TOPIC_LEXRANK_TOP_K,
						TOPIC_QUERY_MAX_CHARS,
						topicHint,
					);

		let queryVector: number[] | null = null;
		if (topicText.length >= 12) {
			try {
				updateState({
					status: "summarizing",
					progress: Math.min(
						98,
						scopeProgressBase + Math.round(scopeProgressSpan * 0.92),
					),
					detail: "Embedding multi-centroid topic query…",
				});
				queryVector = await embedOne(topicText, E5_QUERY_PREFIX);
			} catch (error) {
				console.warn(
					"[LocalAI] Topic query embed failed; LexRank-only MMR:",
					error,
				);
				queryVector = null;
			}
		}

		return rankUnitsLexRankEmbed(
			deduped.units,
			deduped.vectors,
			topK,
			queryVector,
			lexScores,
		);
	};

	const lines: string[] = [];
	const poolUnits: string[] = [];
	const scopeCount = Math.max(scopes.length, 1);
	const sourceChars = text.replace(/\s+/g, " ").trim().length;
	const totalUnits = scopes.reduce(
		(n, sc) => n + (sc.units.length || splitContentUnits(sc.text).length),
		0,
	);
	const globalBulletTarget = targetBulletCount(
		totalUnits,
		fullOutline,
		sourceChars,
		tuning,
	);

	for (let s = 0; s < scopes.length; s += 1) {
		const scope = scopes[s];
		const units =
			scope.units.length > 0 ? scope.units : splitContentUnits(scope.text);
		if (units.length === 0) continue;
		poolUnits.push(...units);

		const progressBase = Math.round((s / scopeCount) * 90);
		const progressSpan = Math.round((1 / scopeCount) * 90);

		updateState({
			status: "summarizing",
			progress: progressBase,
			detail: scope.title
				? `LexRank outline: ${scope.title}…`
				: `LexRank outline (scope ${s + 1}/${scopeCount})…`,
		});

		const perScopeTopK = fullOutline
			? Math.min(
					Math.max(SECTION_TOP_K + 2, Math.ceil(globalBulletTarget / Math.max(scopeCount, 1))),
					globalBulletTarget,
				)
			: scopes.length === 1
				? Math.min(TEXTRANK_TOP_K, Math.max(3, Math.ceil(units.length / 12)))
				: Math.min(
						SECTION_TOP_K,
						Math.max(2, Math.ceil(units.length / 15)),
					);

		// Full-outline: chrono sub-windows whenever we have enough units (not only 100+).
		// Short DOM transcripts (~8 units) still need a last-window pass.
		const useChronoWindows =
			scopes.length === 1 &&
			(fullOutline
				? units.length >= 6
				: units.length > MAP_CHUNK_SENTENCES * 2);
		if (useChronoWindows) {
			const windowSize = fullOutline
				? Math.max(
						3,
						Math.ceil(units.length / Math.max(tuning.chronoWindows, 2)),
					)
				: MAP_CHUNK_SENTENCES;
			const windows = chunkSentences(units, windowSize);
			const windowIndexes = fullOutline
				? pickEvenWindowIndexes(windows.length, tuning.chronoWindows)
				: pickEvenWindowIndexes(windows.length, Math.min(3, windows.length));
			const localWindows = windowIndexes.map((i) => windows[i] ?? []).filter(
				(w) => w.length > 0,
			);
			// Scale per-window K so multi-window sum can reach char/bullet budget.
			const perWindowK = Math.max(
				2,
				Math.ceil(globalBulletTarget / Math.max(localWindows.length, 1)),
			);
			for (let w = 0; w < localWindows.length; w += 1) {
				const ranked = await pickFromUnits(
					localWindows[w],
					perWindowK,
					progressBase + Math.round((w / localWindows.length) * progressSpan),
					Math.round(progressSpan / Math.max(localWindows.length, 1)),
					scope.title,
				);
				if (ranked.length === 0) continue;
				lines.push(...formatProcessedBullets(ranked, tuning));
			}
		} else {
			const ranked = await pickFromUnits(
				units,
				fullOutline
					? Math.max(
							perScopeTopK,
							targetBulletCount(units.length, true, sourceChars, tuning),
						)
					: perScopeTopK,
				progressBase,
				progressSpan,
				scope.title,
			);
			if (ranked.length === 0) continue;
			if (scope.title && scopes.length >= 2) lines.push(`## ${scope.title}`);
			lines.push(...formatProcessedBullets(ranked, tuning));
		}
	}

	updateState({
		status: "ready",
		progress: 100,
		detail: fullOutline
			? "Full-transcript E5 + LexRank outline ready"
			: "Multilingual E5 + LexRank outline ready",
	});

	if (lines.length === 0) return createExtractiveSummary(text, options);
	// De-dupe consecutive identical bullets after multi-window merge
	const deduped: string[] = [];
	const seenKeys = new Set<string>();
	for (const line of lines) {
		if (line.startsWith("##")) {
			deduped.push(line);
			continue;
		}
		const key = line.toLocaleLowerCase();
		if (seenKeys.has(key)) continue;
		const prev = deduped[deduped.length - 1];
		if (prev && prev.toLocaleLowerCase() === key) continue;
		// Near-dup: same first 48 chars
		const prefix = key.replace(/^[-*•]\s*/, "").slice(0, 48);
		let near = false;
		for (const sk of seenKeys) {
			const sp = sk.replace(/^[-*•]\s*/, "").slice(0, 48);
			if (prefix.length > 24 && sp.length > 24 && (prefix.includes(sp) || sp.includes(prefix))) {
				near = true;
				break;
			}
		}
		if (near) continue;
		seenKeys.add(key);
		deduped.push(line);
	}

	// Cap total bullets when multi-window produced too many; always keep last on fullOutline.
	const bulletLines = deduped.filter((l) => !l.startsWith("##"));
	let joined =
		bulletLines.length > globalBulletTarget && fullOutline
			? subsampleUnitsKeepEnds(bulletLines, globalBulletTarget).join("\n")
			: deduped.join("\n");
	// Emit gate + grow/shrink toward configured % of source (tail-reserve when fullOutline).
	joined = validateSummaryOutput(joined, tuning);
	if (joined) {
		joined = fitSummaryToCharBudget(joined, text, poolUnits, tuning, fullOutline);
		if (joined) return joined;
	}
	return createExtractiveSummary(text, options);
}

function splitIntoCharChunks(text: string, chunkChars: number): string[] {
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (normalized.length <= chunkChars) return [normalized];

	const paragraphs = normalized.split(/\n{2,}/);
	const chunks: string[] = [];
	let current = "";

	const flush = () => {
		const piece = current.trim();
		if (piece) chunks.push(piece);
		current = "";
	};

	for (const paragraph of paragraphs) {
		const next = current ? `${current}\n\n${paragraph}` : paragraph;
		if (next.length <= chunkChars) {
			current = next;
			continue;
		}
		if (current) flush();
		if (paragraph.length <= chunkChars) {
			current = paragraph;
			continue;
		}
		const sentences = paragraph.split(/(?<=[.!?…])\s+/u);
		for (const sentence of sentences) {
			const candidate = current ? `${current} ${sentence}` : sentence;
			if (candidate.length > chunkChars && current) {
				flush();
				current = sentence;
			} else if (sentence.length > chunkChars) {
				flush();
				for (let i = 0; i < sentence.length; i += chunkChars) {
					chunks.push(sentence.slice(i, i + chunkChars));
				}
				current = "";
			} else {
				current = candidate;
			}
		}
	}
	flush();
	return chunks.length > 0 ? chunks : [normalized.slice(0, chunkChars)];
}

function selectChunksForNeural(chunks: string[], maxChunks: number): string[] {
	if (chunks.length <= maxChunks) return chunks;
	return Array.from({ length: maxChunks }, (_, index) => {
		const offset = Math.round(
			(index * (chunks.length - 1)) / Math.max(maxChunks - 1, 1),
		);
		return chunks[offset];
	});
}

export function buildRussianNeuralChunks(
	text: string,
	options: BuildScopesOptions,
): string[] {
	const chunks: string[] = [];
	const scopes = buildSummaryScopes(text, options);

	for (const scope of scopes) {
		const units =
			scope.units.length > 0 ? scope.units : splitContentUnits(scope.text || text);
		let current = "";
		for (const unit of units) {
			const candidate = current ? `${current} ${unit}` : unit;
			if (current && candidate.length > RU_NEURAL_CHUNK_CHARS) {
				chunks.push(current);
				current = unit;
			} else {
				current = candidate;
			}
		}
		if (current) chunks.push(current);
	}

	const fallback = chunks.length > 0 ? chunks : splitIntoCharChunks(text, RU_NEURAL_CHUNK_CHARS);
	return selectChunksForNeural(fallback, RU_NEURAL_MAX_CHUNKS);
}

export function generatedSummaryOverlap(summary: string, source: string): number {
	const generated = [...new Set(tokenize(summary))];
	if (generated.length === 0) return 0;
	const sourceTokens = new Set(tokenize(source));
	let overlap = 0;
	for (const token of generated) {
		if (sourceTokens.has(token)) overlap += 1;
	}
	return overlap / generated.length;
}

/**
 * Fail-closed gate for browser two-pass / polish output.
 * Rejects ultra-short abstracts and low-overlap inventions.
 */
export function isAcceptableGeneratedSummary(
	summary: string,
	source: string,
	options: {
		minimumOverlap?: number;
		minBodyRatioOfPrior?: number;
		priorBodyChars?: number;
	} & SummaryTuningOptions = {},
): boolean {
	const cleaned = validateSummaryOutput(summary, options);
	if (!cleaned) return false;
	const sourceChars = source.replace(/\s+/g, " ").trim().length;
	const body = summaryBodyChars(cleaned);
	const budget = summaryCharBudget(sourceChars, options);
	const minOverlap = options.minimumOverlap ?? 0.2;
	const t = resolveTuning(options);

	if (isDegenerateGeneratedText(cleaned)) return false;
	if (generatedSummaryOverlap(cleaned, source) < minOverlap) return false;

	const bulletCount = cleaned.split(/\n+/).filter((l) => /^[-*•]\s+/.test(l.trim())).length;
	if (sourceChars >= SUMMARY_RATIO_ENFORCE_SOURCE_CHARS) {
		if (body < budget.min) return false;
		if (bulletCount < Math.min(2, t.minBullets)) return false;
	} else if (body < 40) {
		return false;
	}

	// Soft ceiling: allow slight overshoot; hard reject absurd dumps.
	if (sourceChars >= 400 && body > budget.max * 1.35) return false;

	if (
		typeof options.priorBodyChars === "number" &&
		options.priorBodyChars >= 80 &&
		typeof options.minBodyRatioOfPrior === "number"
	) {
		if (body < options.priorBodyChars * options.minBodyRatioOfPrior) return false;
	}

	return true;
}

/**
 * Grow or shrink extractive markdown toward the configured char budget.
 * Only uses units that already pass validateSummaryBullet (no mid-phrase pad).
 * When fullOutline: fill by head/mid/tail quotas and force ≥1 tail unit if possible.
 */
export function fitSummaryToCharBudget(
	markdown: string,
	source: string,
	poolUnits: string[] = [],
	tuning: SummaryTuningOptions = {},
	fullOutline = false,
): string {
	const t = resolveTuning(tuning);
	const sourceChars = source.replace(/\s+/g, " ").trim().length;
	if (sourceChars < 200) {
		return validateSummaryOutput(markdown, t) || markdown;
	}
	const budget = summaryCharBudget(sourceChars, t);
	let lines = (validateSummaryOutput(markdown, t) || "")
		.split(/\n+/)
		.map((l) => l.trim())
		.filter((l) => l.startsWith("-"));

	const bodyOf = (ls: string[]) => summaryBodyChars(ls.join("\n"));
	const bodyKey = (u: string) => u.toLocaleLowerCase().replace(/^[-*•]\s+/, "").slice(0, 64);
	const seen = new Set(lines.map((l) => bodyKey(l)));

	const isNearDup = (key: string): boolean => {
		for (const sk of seen) {
			if (key.length > 24 && sk.length > 24 && (key.includes(sk) || sk.includes(key))) {
				return true;
			}
		}
		return false;
	};

	const tryAppend = (unit: string, force = false): boolean => {
		const key = bodyKey(unit);
		if (seen.has(key) || isNearDup(key)) return false;
		const next = unit.startsWith("-") ? unit : `- ${unit}`;
		const body = next.replace(/^[-*•]\s+/, "");
		if (!validateSummaryBullet(body)) return false;
		if (!force && bodyOf([...lines, next]) > budget.max && lines.length >= t.minBullets) {
			return false;
		}
		if (force && bodyOf([...lines, next]) > budget.max * 1.05 && lines.length >= t.minBullets) {
			// Allow slight overshoot only when forcing tail coverage.
			if (bodyOf([...lines, next]) > budget.max * 1.12) return false;
		}
		seen.add(key);
		lines.push(next.startsWith("-") ? next : `- ${body}`);
		return true;
	};

	const eligible = poolUnits
		.map((u) => truncateAtClauseBoundary(u, t.maxBulletChars))
		.filter((u) => validateSummaryBullet(u));

	const n = eligible.length;
	const headEnd = Math.max(1, Math.floor(n / 3));
	const tailStart = Math.min(n - 1, Math.floor((2 * n) / 3));
	const headBand = eligible.slice(0, headEnd);
	const midBand = eligible.slice(headEnd, tailStart);
	const tailBand = eligible.slice(tailStart);

	const coversTail = (): boolean => {
		if (tailBand.length === 0) return true;
		const tailKeys = new Set(tailBand.map((u) => bodyKey(u)));
		return lines.some((l) => {
			const k = bodyKey(l);
			if (tailKeys.has(k)) return true;
			// Prefix overlap with a tail unit (truncation).
			for (const tk of tailKeys) {
				if (k.length > 28 && tk.length > 28 && (k.includes(tk.slice(0, 32)) || tk.includes(k.slice(0, 32)))) {
					return true;
				}
			}
			return false;
		});
	};

	// Force ≥1 emit-eligible unit from last third when full outline.
	if (fullOutline && n >= 6 && !coversTail()) {
		const rankedTail = [...tailBand].sort(
			(a, b) => unitInfoScore(b) - unitInfoScore(a),
		);
		for (const unit of rankedTail) {
			if (tryAppend(unit, true)) break;
		}
	}

	// Fill toward target with head/mid/tail quotas (avoid head-only early stop).
	if (bodyOf(lines) < budget.target && eligible.length > 0) {
		const remaining = () => Math.max(0, budget.target - bodyOf(lines));
		const bands = fullOutline
			? [
					{ units: headBand, share: 0.4 },
					{ units: midBand, share: 0.3 },
					{ units: tailBand, share: 0.3 },
				]
			: [{ units: eligible, share: 1 }];

		for (const band of bands) {
			if (bodyOf(lines) >= budget.target) break;
			if (lines.length >= t.maxBullets) break;
			const bandBudget = remaining() * band.share + bodyOf(lines);
			// Prefer higher-info within band but walk roughly chrono.
			const ordered = [...band.units].sort(
				(a, b) => unitInfoScore(b) - unitInfoScore(a),
			);
			for (const unit of ordered) {
				if (bodyOf(lines) >= bandBudget && bodyOf(lines) >= budget.target * 0.85) {
					break;
				}
				if (bodyOf(lines) >= budget.target) break;
				if (lines.length >= t.maxBullets) break;
				tryAppend(unit, false);
			}
		}

		// Any leftover capacity: chrono walk of remaining eligible.
		if (bodyOf(lines) < budget.target) {
			for (const unit of eligible) {
				if (bodyOf(lines) >= budget.target) break;
				if (lines.length >= t.maxBullets) break;
				tryAppend(unit, false);
			}
		}
	}

	// Re-check tail after fill (early units may have been preferred).
	if (fullOutline && n >= 6 && !coversTail()) {
		const rankedTail = [...tailBand].sort(
			(a, b) => unitInfoScore(b) - unitInfoScore(a),
		);
		for (const unit of rankedTail) {
			if (tryAppend(unit, true)) break;
		}
	}

	// Trim over max: drop lowest-info lines but never drop the only tail-covering line.
	if (bodyOf(lines) > budget.max && lines.length > t.minBullets) {
		const scored = lines.map((line, index) => ({
			line,
			index,
			info: unitInfoScore(line.replace(/^[-*•]\s+/, "")),
			isLast: index === lines.length - 1,
		}));
		const drop = new Set<number>();
		const byInfoAsc = [...scored].sort((a, b) => a.info - b.info);
		for (const item of byInfoAsc) {
			if (bodyOf(lines.filter((_, i) => !drop.has(i))) <= budget.max) break;
			if (lines.length - drop.size <= t.minBullets) break;
			// Prefer keeping the last chrono bullet (often closing).
			if (fullOutline && item.isLast && lines.length - drop.size > t.minBullets + 1) {
				continue;
			}
			drop.add(item.index);
		}
		lines = lines.filter((_, i) => !drop.has(i));
	}

	// Chrono order among survivors for full outline readability.
	if (fullOutline && lines.length > 1 && poolUnits.length > 0) {
		const order = new Map(
			poolUnits.map((u, i) => [bodyKey(u), i] as const),
		);
		lines = [...lines].sort((a, b) => {
			const ia = order.get(bodyKey(a)) ?? 0;
			const ib = order.get(bodyKey(b)) ?? 0;
			return ia - ib;
		});
	}

	return lines.join("\n");
}

export function isDegenerateGeneratedText(text: string): boolean {
	const words = text.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? [];
	if (words.length < 14) return false;

	const counts = new Map<string, number>();
	for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
	const repeatedShare =
		[...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0) /
		words.length;
	const maxShare = Math.max(...counts.values()) / words.length;
	if (repeatedShare >= 0.38) return true;
	if (repeatedShare >= 0.3 && maxShare >= 0.19) return true;

	const trigrams = new Set<string>();
	for (let index = 0; index < words.length - 2; index += 1) {
		const trigram = words.slice(index, index + 3).join(" ");
		if (trigrams.has(trigram)) return true;
		trigrams.add(trigram);
	}
	return /(?:^|\s)(?:вот|и|я)(?:\s+(?:вот|и|я)){5,}(?:\s|$)/iu.test(text);
}

function formatGeneratedBullet(
	summary: string,
	source: string,
	minimumOverlap = 0.2,
): string | null {
	let bullet = summary
		.replace(/^#{1,6}\s+/gmu, "")
		.replace(/^[-*•]\s+/gmu, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!isUsableSummaryText(bullet) || isDegenerateGeneratedText(bullet)) return null;
	if (generatedSummaryOverlap(bullet, source) < minimumOverlap) return null;

	if (bullet.length > MAX_OUTPUT_BULLET_CHARS) {
		const sentences = bullet.split(/(?<=[.!?…])\s+/u);
		let compact = "";
		for (const sentence of sentences) {
			const candidate = compact ? `${compact} ${sentence}` : sentence;
			if (candidate.length > MAX_OUTPUT_BULLET_CHARS) break;
			compact = candidate;
		}
		bullet = compact || bullet.slice(0, MAX_OUTPUT_BULLET_CHARS);
		bullet = bullet.replace(/\s+\S*$/u, "").trim();
	}
	if (bullet.length < 20) return null;
	if (!/[.!?…]$/u.test(bullet)) bullet += ".";
	return bullet;
}

function generatedBulletSimilarity(left: string, right: string): number {
	const a = new Set(tokenize(left));
	const b = new Set(tokenize(right));
	if (a.size === 0 || b.size === 0) return 0;
	let overlap = 0;
	for (const token of a) {
		if (b.has(token)) overlap += 1;
	}
	return overlap / Math.max(1, Math.min(a.size, b.size));
}

export async function summarizeWithRussianNeuralMapReduce(
	text: string,
	options: BuildScopesOptions = {},
): Promise<string> {
	const chunks = buildRussianNeuralChunks(text, options);
	if (chunks.length === 0) throw new Error("No Russian summary chunks");
	const pipe = await loadRuSummarizationPipeline();
	const bullets: string[] = [];

	for (let i = 0; i < chunks.length; i += 1) {
		updateState({
			status: "summarizing",
			progress: Math.round(((i + 0.5) / chunks.length) * 100),
			detail: `Summarizing Russian text (part ${i + 1}/${chunks.length})…`,
		});
		const generated = extractGeneratedText(
			await pipe(chunks[i], {
				max_new_tokens: RU_NEURAL_MAX_NEW_TOKENS,
				min_new_tokens: RU_NEURAL_MIN_NEW_TOKENS,
				no_repeat_ngram_size: 4,
				num_beams: 3,
				early_stopping: true,
			}),
		);
		const bullet = formatGeneratedBullet(generated, chunks[i]);
		if (!bullet) continue;
		if (bullets.some((existing) => generatedBulletSimilarity(existing, bullet) >= 0.8)) {
			continue;
		}
		bullets.push(bullet);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	if (bullets.length === 0) {
		throw new Error("Russian summarization model returned no grounded notes");
	}
	updateState({
		status: "ready",
		progress: 100,
		detail: "Russian abstractive summary ready",
	});
	return bullets.map((bullet) => `- ${bullet}`).join("\n");
}

function cleanInstructionOutput(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/giu, "")
		.replace(/^[\s\S]*?<\/think>\s*/iu, "")
		.replace(/<think>[\s\S]*$/giu, "")
		.replace(/```(?:markdown|text)?/giu, "")
		.replace(/^assistant\s*:?\s*/iu, "")
		.trim();
}

export function parseInstructionSummary(output: string, source: string): string {
	const cleaned = cleanInstructionOutput(output);
	const entries: string[] = [];
	let current = "";
	for (const rawLine of cleaned.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || /^#{1,6}\s/u.test(line)) continue;
		const match = line.match(/^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+)$/u);
		if (match) {
			if (current) entries.push(current);
			current = match[1].trim();
		} else if (current) {
			current += ` ${line}`;
		}
	}
	if (current) entries.push(current);

	const candidates =
		entries.length > 0
			? entries
			: cleaned
					.split(/(?<=[.!?…])\s+|\n+/u)
					.map((entry) => entry.trim())
					.filter(Boolean);
	const bullets: string[] = [];
	for (const candidate of candidates) {
		const bullet = formatGeneratedBullet(candidate, source, 0.08);
		if (!bullet) continue;
		if (bullets.some((existing) => generatedBulletSimilarity(existing, bullet) >= 0.8)) {
			continue;
		}
		bullets.push(bullet);
		if (bullets.length >= 6) break;
	}
	return bullets.map((bullet) => `- ${bullet}`).join("\n");
}

function qwenMapMessages(
	chunk: string,
	index: number,
	total: number,
	title: string,
): ChatMessage[] {
	return [
		{
			role: "system",
			content:
				"You edit noisy Russian speech transcripts. Use only facts explicitly supported by the source. Never continue broken phrases or invent missing words. Return exactly 2 or 3 concise factual notes in Russian, each on its own line beginning with '-'.",
		},
		{
			role: "user",
			content: `Video title: ${title}\nTranscript fragment ${index + 1} of ${total}:\n<transcript>\n${chunk}\n</transcript>\nExtract the important claims while preserving the speaker's position. /no_think`,
		},
	];
}

function qwenReduceMessages(notes: string[], title: string): ChatMessage[] {
	return [
		{
			role: "system",
			content:
				"You create coherent Russian video summaries from chronological factual notes. Use only the supplied notes. Merge repetitions, preserve important contrasts, and do not add an introduction or commentary. Return only 4 to 6 concise Markdown bullets in Russian. Each bullet must express one complete idea.",
		},
		{
			role: "user",
			content: `Video title: ${title}\nChronological notes:\n${notes.map((note) => `- ${note}`).join("\n")}\nCreate the final summary. /no_think`,
		},
	];
}

export async function summarizeWithQwenMapReduce(
	text: string,
	model: QwenSummaryModel,
	options: BuildScopesOptions = {},
): Promise<string> {
	const chunks = buildRussianNeuralChunks(text, options);
	if (chunks.length === 0) throw new Error("No Qwen summary chunks");
	const pipe = await loadQwenPipeline(model);
	const title = options.topicHint?.trim() || "Untitled video";

	const notes: string[] = [];
	for (let index = 0; index < chunks.length; index += 1) {
		updateState({
			status: "summarizing",
			progress: Math.round(((index + 0.5) / (chunks.length + 1)) * 90),
			detail: `Extracting facts with ${qwenModelDetails(model).label} (part ${index + 1}/${chunks.length})…`,
		});
		const generated = extractGeneratedText(
			await pipe(qwenMapMessages(chunks[index], index, chunks.length, title), {
				max_new_tokens: 220,
				do_sample: false,
				repetition_penalty: 1.08,
				no_repeat_ngram_size: 3,
			}),
		);
		const partial = parseInstructionSummary(generated, chunks[index]);
		for (const line of partial.split("\n")) {
			const note = line.replace(/^[-*•]\s+/u, "").trim();
			if (!note) continue;
			if (notes.some((existing) => generatedBulletSimilarity(existing, note) >= 0.8)) {
				continue;
			}
			notes.push(note);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	if (notes.length < 3) {
		throw new Error("Qwen returned too few grounded notes");
	}
	updateState({
		status: "summarizing",
		progress: 94,
		detail: `Combining notes with ${qwenModelDetails(model).label}…`,
	});
	const reduced = extractGeneratedText(
		await pipe(qwenReduceMessages(notes, title), {
			max_new_tokens: 360,
			do_sample: false,
			repetition_penalty: 1.08,
			no_repeat_ngram_size: 3,
		}),
	);
	let summary = validateSummaryOutput(parseInstructionSummary(reduced, text));
	if (summary.split("\n").filter((l) => l.startsWith("-")).length < 3) {
		const indexes = pickEvenWindowIndexes(notes.length, Math.min(6, notes.length));
		summary = validateSummaryOutput(
			indexes.map((index) => `- ${notes[index]}`).join("\n"),
		);
	}
	if (summary.split("\n").filter((l) => l.startsWith("-")).length < 3) {
		throw new Error("Qwen summary failed completeness validation");
	}
	updateState({
		status: "ready",
		progress: 100,
		detail: `${qwenModelDetails(model).label} summary ready`,
	});
	return summary;
}

async function runNeuralOnChunk(chunk: string): Promise<string> {
	const options = {
		max_new_tokens: NEURAL_MAX_NEW_TOKENS,
		min_new_tokens: NEURAL_MIN_NEW_TOKENS,
		no_repeat_ngram_size: 3,
	};

	if (!enModelUnavailable) {
		try {
			const pipe = await loadEnSummarizationPipeline();
			const text = extractGeneratedText(await pipe(chunk, options));
			if (isUsableSummaryText(text)) return text;
		} catch (error) {
			console.warn("[LocalAI] EN summarizer chunk failed:", error);
			enModelUnavailable = true;
			enPipelinePromise = null;
		}
	}

	return createExtractiveSummary(chunk);
}

/** English DistilBART map–reduce. */
export async function summarizeWithNeuralMapReduce(
	text: string,
	_language: TranscriptionLanguage,
): Promise<string> {
	const allChunks = splitIntoCharChunks(text, NEURAL_CHUNK_CHARS);
	const chunks = selectChunksForNeural(allChunks, NEURAL_MAX_MAP_CHUNKS);

	if (chunks.length === 1 && chunks[0].length < MIN_NEURAL_INPUT_CHARS) {
		return createExtractiveSummary(text);
	}

	const partials: string[] = [];
	for (let i = 0; i < chunks.length; i += 1) {
		updateState({
			status: "summarizing",
			progress: Math.round(((i + 0.5) / (chunks.length + 1)) * 100),
			detail: `Summarizing with local AI (part ${i + 1}/${chunks.length})…`,
		});
		const partial = await runNeuralOnChunk(chunks[i]);
		if (
			isUsableSummaryText(partial) ||
			partial.includes("\n-") ||
			partial.startsWith("-")
		) {
			partials.push(partial.trim());
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	if (partials.length === 0) return createExtractiveSummary(text);

	updateState({
		status: "summarizing",
		progress: 92,
		detail: "Combining partial summaries…",
	});

	if (partials.length === 1) {
		const single = partials[0];
		updateState({ status: "ready", progress: 100, detail: "Summary ready" });
		if (!isUsableSummaryText(single) && !single.includes("-")) {
			return createExtractiveSummary(text);
		}
		return /^[-*#]/m.test(single)
			? single
			: single
					.split(/(?<=[.!?…])\s+/)
					.filter((line) => line.trim().length > 0)
					.map((line) => `- ${normalizePoint(line)}`)
					.join("\n");
	}

	const combined = partials
		.map((part, index) => `Part ${index + 1}:\n${part}`)
		.join("\n\n");

	let finalText: string;
	if (combined.length <= NEURAL_CHUNK_CHARS * 1.5 && !enModelUnavailable) {
		finalText = await runNeuralOnChunk(combined);
		if (!isUsableSummaryText(finalText) && !finalText.includes("-")) {
			finalText = createExtractiveSummary(partials.join("\n"));
		}
	} else {
		finalText = createExtractiveSummary(partials.join("\n"));
	}

	updateState({ status: "ready", progress: 100, detail: "Summary ready" });

	if (/^[-*#]/m.test(finalText.trim()) || finalText.includes("\n-")) {
		return finalText.trim();
	}
	if (!isUsableSummaryText(finalText)) return createExtractiveSummary(text);

	return finalText
		.split(/(?<=[.!?…])\s+|\n+/)
		.map((line) => line.trim())
		.filter((line) => line.length > 12)
		.map((line) => `- ${normalizePoint(line.replace(/^[-*•]\s*/, ""))}`)
		.join("\n");
}

export async function summarizeLocally(
	prompt: string,
	language: TranscriptionLanguage,
	options: BuildScopesOptions = {},
): Promise<string> {
	const content = getPromptContent(prompt);
	if (!content) {
		throw new Error("No text to summarize");
	}

	const preferEnglish =
		language === "english" || isPrimarilyEnglish(content.slice(0, 2_000));

	// English generative model.
	if (preferEnglish && !enModelUnavailable && content.length >= MIN_NEURAL_INPUT_CHARS) {
		try {
			const neural = await summarizeWithNeuralMapReduce(content, language);
			if (
				isUsableSummaryText(neural) ||
				neural.includes("\n-") ||
				neural.startsWith("-")
			) {
				return neural;
			}
		} catch (error) {
			console.warn("[LocalAI] EN neural summary failed:", error);
		}
	}

	const localSummaryModel = options.localSummaryModel ?? "balanced";

	// Qwen map-reduce is disabled until grounded acceptance gates land.
	// 0.6B invented topics/labels; prefer faithful extractive (E5 / TextRank).
	releaseQwenPipelinesExcept();
	if (localSummaryModel === "quality" || localSummaryModel === "balanced") {
		// Fall through to multilingual E5 extractive below.
	}

	// Fast retains RuT5, but rejects repetitive degeneration before returning it.
	if (
		!preferEnglish &&
		language === "russian" &&
		localSummaryModel === "fast" &&
		!ruModelUnavailable &&
		content.length >= MIN_NEURAL_INPUT_CHARS
	) {
		try {
			return await summarizeWithRussianNeuralMapReduce(content, options);
		} catch (error) {
			console.warn(
				"[LocalAI] Russian neural summary failed; using embedding fallback:",
				error,
			);
			ruPipelinePromise = null;
			if (error instanceof Error && /unavailable|load|download|fetch/i.test(error.message)) {
				ruModelUnavailable = true;
			}
		}
	}

	// Multilingual extractive fallback (still works offline after model caching).
	if (!preferEnglish && !embedModelUnavailable && content.length >= MIN_NEURAL_INPUT_CHARS) {
		try {
			return await summarizeWithEmbeddings(content, options);
		} catch (error) {
			console.warn(
				"[LocalAI] Multilingual embedding summary failed; TextRank fallback:",
				error,
			);
			// Do not permanently poison the session on a one-shot ranking/runtime error.
			// Only mark unavailable if the pipeline never successfully loaded.
			embedPipelinePromise = null;
			if (error instanceof Error && /unavailable|load|download|fetch/i.test(error.message)) {
				embedModelUnavailable = true;
			}
		}
	}

	updateState({
		status: "extractive",
		progress: 0,
		detail: preferEnglish
			? "Using extractive TextRank summary"
			: "Using extractive TextRank (embedding model unavailable)",
	});
	return createExtractiveSummary(content, options);
}
