import type { TranscriptionLanguage } from "@/jotai/transcriptionSettings";

const LOCAL_SUMMARIZATION_MODEL = "Xenova/distilbart-cnn-6-6";
const MIN_NEURAL_INPUT_CHARS = 320;
const MAX_NEURAL_INPUT_CHARS = 4_000;
const MAX_EXTRACTIVE_POINTS = 7;

export type LocalSummarizerState = {
	status: "idle" | "loading" | "ready" | "extractive";
	progress: number;
};

type SummarizationResult = { summary_text: string };
type SummarizationPipeline = (
	text: string,
	options?: Record<string, unknown>,
) => Promise<SummarizationResult | SummarizationResult[]>;

type ProgressInfo = {
	status: string;
	progress?: number;
};

let localState: LocalSummarizerState = { status: "idle", progress: 0 };
let pipelinePromise: Promise<SummarizationPipeline> | null = null;
let neuralModelUnavailable = false;
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

function splitSentences(text: string): string[] {
	return text
		.replace(/^#{1,6}\s+/gm, "")
		.split(/(?<=[.!?…])\s+|\n+/u)
		.map((sentence) => sentence.replace(/^[-*•]\s*/, "").trim())
		.filter((sentence) => sentence.length >= 24 && sentence !== "---");
}

function normalizePoint(sentence: string): string {
	return sentence.replace(/\s+/g, " ").replace(/[;,]+$/, "").trim();
}

/**
 * Language-agnostic, offline fallback used for non-English text and when the
 * optional neural model cannot be loaded. It selects representative sentences
 * without sending transcript text outside the extension.
 */
export function createExtractiveSummary(text: string): string {
	const sentences = splitSentences(text);
	if (sentences.length === 0) {
		const normalized = normalizePoint(text);
		return normalized ? `- ${normalized}` : "- No summary content was found.";
	}

	const frequencies = new Map<string, number>();
	for (const sentence of sentences) {
		for (const word of new Set(tokenize(sentence))) {
			frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
		}
	}

	const scored = sentences.map((sentence, index) => {
		const words = tokenize(sentence);
		const frequencyScore = words.reduce((sum, word) => sum + (frequencies.get(word) ?? 0), 0);
		const positionBoost = index < 2 ? 1.35 : 1;
		const actionBoost =
			/\b(action|decision|must|need|next|todo|agreed|решени|нужно|надо|следующ|задач)/iu.test(
				sentence,
			)
				? 1.3
				: 1;
		return {
			index,
			sentence: normalizePoint(sentence),
			score: (frequencyScore / Math.max(Math.sqrt(words.length), 1)) * positionBoost * actionBoost,
		};
	});

	const pointCount = Math.min(MAX_EXTRACTIVE_POINTS, Math.max(2, Math.ceil(sentences.length * 0.3)));
	const selected = scored
		.sort((left, right) => right.score - left.score)
		.slice(0, pointCount)
		.sort((left, right) => left.index - right.index);

	return selected.map(({ sentence }) => `- ${sentence}`).join("\n");
}

function isPrimarilyEnglish(text: string): boolean {
	const letters = text.match(/\p{L}/gu) ?? [];
	if (letters.length === 0) return false;
	const latinLetters = text.match(/[A-Za-z]/g) ?? [];
	return latinLetters.length / letters.length >= 0.85;
}

function shouldUseNeuralModel(text: string, language: TranscriptionLanguage): boolean {
	return (
		!neuralModelUnavailable &&
		language === "english" &&
		text.length >= MIN_NEURAL_INPUT_CHARS &&
		text.length <= MAX_NEURAL_INPUT_CHARS &&
		isPrimarilyEnglish(text)
	);
}

function handleModelProgress(info: ProgressInfo): void {
	if (info.status === "ready") {
		updateState({ status: "ready", progress: 100 });
		return;
	}

	const progress =
		typeof info.progress === "number"
			? Math.max(0, Math.min(100, Math.round(info.progress)))
			: localState.progress;
	updateState({ status: "loading", progress });
}

async function loadPipeline(): Promise<SummarizationPipeline> {
	if (!pipelinePromise) {
		updateState({ status: "loading", progress: 0 });
		pipelinePromise = (async () => {
			// ONNX must be configured before transformers.js is evaluated because
			// extension pages cannot execute the runtime from a public CDN.
			await import("../ort-env-bootstrap");
			const { env, pipeline } = await import("@huggingface/transformers");
			env.allowLocalModels = false;
			env.useBrowserCache = true;
			const summarizer = await pipeline("summarization", LOCAL_SUMMARIZATION_MODEL, {
				dtype: "q8",
				device: "wasm",
				progress_callback: handleModelProgress,
			});
			updateState({ status: "ready", progress: 100 });
			return summarizer as SummarizationPipeline;
		})().catch((error) => {
			pipelinePromise = null;
			neuralModelUnavailable = true;
			updateState({ status: "extractive", progress: 0 });
			throw error;
		});
	}

	return pipelinePromise;
}

function formatNeuralSummary(summary: string): string {
	const normalized = summary.trim();
	if (!normalized || /^[-*#]/m.test(normalized)) {
		return normalized;
	}

	const sentences = splitSentences(normalized);
	return sentences.length > 1
		? sentences.map((sentence) => `- ${normalizePoint(sentence)}`).join("\n")
		: normalized;
}

export async function summarizeLocally(
	prompt: string,
	language: TranscriptionLanguage,
): Promise<string> {
	const content = getPromptContent(prompt);
	if (!content) {
		throw new Error("No text to summarize");
	}

	if (!shouldUseNeuralModel(content, language)) {
		return createExtractiveSummary(content);
	}

	try {
		const summarizer = await loadPipeline();
		const result = await summarizer(content.slice(0, MAX_NEURAL_INPUT_CHARS), {
			max_new_tokens: 180,
			min_new_tokens: 24,
			no_repeat_ngram_size: 3,
		});
		const first = Array.isArray(result) ? result[0] : result;
		const summary = formatNeuralSummary(first?.summary_text ?? "");
		return summary || createExtractiveSummary(content);
	} catch (error) {
		console.warn("[LocalAI] Neural summarizer failed; using extractive fallback:", error);
		return createExtractiveSummary(content);
	}
}
