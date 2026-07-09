/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-unused-vars */
import {
	AutoProcessor,
	AutoTokenizer,
	Tensor,
	TextStreamer,
	WhisperForConditionalGeneration,
} from "@huggingface/transformers";
import { safeRuntimeSendMessage } from "./lib/runtimeMessaging";

const WHISPER_SAMPLE_RATE = 16_000;

const MAX_NEW_TOKENS = 128;

let currentModelId = "onnx-community/whisper-base";
// WebGPU is unreliable in Chrome extension offscreen on Windows (JSEP Conv errors).
let currentDevice = "wasm";

const LANGUAGE_NAME_TO_CODE = {
	english: "en",
	chinese: "zh",
	german: "de",
	"spanish/castilian": "es",
	russian: "ru",
	korean: "ko",
	french: "fr",
	japanese: "ja",
	portuguese: "pt",
	turkish: "tr",
	polish: "pl",
	"catalan/valencian": "ca",
	"dutch/flemish": "nl",
	arabic: "ar",
	swedish: "sv",
	italian: "it",
	indonesian: "id",
	hindi: "hi",
	finnish: "fi",
	vietnamese: "vi",
	hebrew: "he",
	ukrainian: "uk",
	greek: "el",
	malay: "ms",
	czech: "cs",
	"romanian/moldavian/moldovan": "ro",
	danish: "da",
	hungarian: "hu",
	tamil: "ta",
	norwegian: "no",
	thai: "th",
	urdu: "ur",
	croatian: "hr",
	bulgarian: "bg",
	lithuanian: "lt",
	latin: "la",
	maori: "mi",
	malayalam: "ml",
	welsh: "cy",
	slovak: "sk",
	telugu: "te",
	persian: "fa",
	latvian: "lv",
	bengali: "bn",
	serbian: "sr",
	azerbaijani: "az",
	slovenian: "sl",
	kannada: "kn",
	estonian: "et",
	macedonian: "mk",
	breton: "br",
	basque: "eu",
	icelandic: "is",
	armenian: "hy",
	nepali: "ne",
	mongolian: "mn",
	bosnian: "bs",
	kazakh: "kk",
	albanian: "sq",
	swahili: "sw",
	galician: "gl",
	marathi: "mr",
	"punjabi/panjabi": "pa",
	"sinhala/sinhalese": "si",
	khmer: "km",
	shona: "sn",
	yoruba: "yo",
	somali: "so",
	afrikaans: "af",
	occitan: "oc",
	georgian: "ka",
	belarusian: "be",
	tajik: "tg",
	sindhi: "sd",
	gujarati: "gu",
	amharic: "am",
	yiddish: "yi",
	lao: "lo",
	uzbek: "uz",
	faroese: "fo",
	"haitian creole/haitian": "ht",
	"pashto/pushto": "ps",
	turkmen: "tk",
	nynorsk: "nn",
	maltese: "mt",
	sanskrit: "sa",
	"luxembourgish/letzeburgesch": "lb",
	"myanmar/burmese": "my",
	tibetan: "bo",
	tagalog: "tl",
	malagasy: "mg",
	assamese: "as",
	tatar: "tt",
	hawaiian: "haw",
	lingala: "ln",
	hausa: "ha",
	bashkir: "ba",
	javanese: "jw",
	sundanese: "su",
};

class AutomaticSpeechRecognitionPipeline {
	static model_id = null;
	static tokenizer = null;
	static processor = null;
	static model = null;

	static reset() {
		this.tokenizer = null;
		this.processor = null;
		this.model = null;
	}

	static async getInstance(progress_callback = null, modelId = null, device = null) {
		if (modelId) currentModelId = modelId;
		if (device) currentDevice = device;

		this.model_id = currentModelId;

		this.tokenizer ??= AutoTokenizer.from_pretrained(this.model_id, { progress_callback });
		this.processor ??= AutoProcessor.from_pretrained(this.model_id, { progress_callback });

		this.model ??= WhisperForConditionalGeneration.from_pretrained(this.model_id, {
			dtype: "fp32",
			device: currentDevice,
			progress_callback,
		});
		return Promise.all([this.tokenizer, this.processor, this.model]);
	}
}

function toWhisperLanguage(language) {
	if (!language || typeof language !== "string") return language;
	return language.includes("/") ? language.split("/")[0].trim() : language;
}

function resolveWhisperLanguage(language) {
	if (!language) return null;
	const normalized = toWhisperLanguage(language).toLowerCase();
	if (/^[a-z]{2,3}$/.test(normalized)) return normalized;
	return LANGUAGE_NAME_TO_CODE[normalized] ?? null;
}

const SLAVIC_LANGUAGE_CODES = new Set(["ru", "uk", "be", "bg", "sr", "mk", "kk"]);
const LANGUAGE_PRIORITY_MARGIN = 1.0;
const MIN_LANGUAGE_DETECTION_SAMPLES = WHISPER_SAMPLE_RATE / 2;
const MAX_LANGUAGE_DETECTION_SAMPLES = WHISPER_SAMPLE_RATE * 30;

function applyLanguageDetectionPriority(detectedLanguage, languageScores, priorityLanguage) {
	const priorityCode = resolveWhisperLanguage(priorityLanguage);
	if (!priorityCode || priorityCode !== "ru") {
		return detectedLanguage;
	}

	const bestScore = languageScores.get(detectedLanguage) ?? Number.NEGATIVE_INFINITY;
	const russianScore = languageScores.get("ru") ?? Number.NEGATIVE_INFINITY;
	if (russianScore === Number.NEGATIVE_INFINITY) {
		return detectedLanguage;
	}

	if (
		detectedLanguage !== "ru" &&
		(russianScore >= bestScore - LANGUAGE_PRIORITY_MARGIN ||
			(SLAVIC_LANGUAGE_CODES.has(detectedLanguage) &&
				russianScore >= bestScore - LANGUAGE_PRIORITY_MARGIN * 1.5))
	) {
		return "ru";
	}

	return detectedLanguage;
}

async function detectWhisperLanguage(model, processor, audio) {
	const samplingRate = processor.feature_extractor.config.sampling_rate ?? WHISPER_SAMPLE_RATE;
	const detectionAudio =
		audio.length > MAX_LANGUAGE_DETECTION_SAMPLES
			? audio.subarray(0, MAX_LANGUAGE_DETECTION_SAMPLES)
			: audio;

	if (detectionAudio.length < MIN_LANGUAGE_DETECTION_SAMPLES) {
		return null;
	}

	const generationConfig = model._prepare_generation_config(null, { task: "transcribe" });
	if (!generationConfig?.is_multilingual || !generationConfig.lang_to_id) {
		return null;
	}

	const inputs = await processor(detectionAudio);
	const decoderStartTokenId = generationConfig.decoder_start_token_id;
	if (decoderStartTokenId == null) {
		return null;
	}

	const decoderInputIds = new Tensor(
		"int64",
		BigInt64Array.from([BigInt(decoderStartTokenId)]),
		[1, 1],
	);

	const outputs = await model.forward({
		input_features: inputs.input_features,
		decoder_input_ids: decoderInputIds,
	});

	const logits = outputs?.logits?.tolist?.();
	if (!logits?.[0]?.length) {
		return null;
	}

	const nextTokenLogits = logits[0][logits[0].length - 1];
	const languageScores = new Map();

	for (const [token, tokenId] of Object.entries(generationConfig.lang_to_id)) {
		const match = token.match(/^<\|([a-z]{2})\|>$/);
		if (!match || typeof tokenId !== "number") continue;
		languageScores.set(match[1], nextTokenLogits[tokenId] ?? Number.NEGATIVE_INFINITY);
	}

	if (languageScores.size === 0) {
		return null;
	}

	let detectedLanguage = "en";
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const [code, score] of languageScores.entries()) {
		if (score > bestScore) {
			bestScore = score;
			detectedLanguage = code;
		}
	}

	return { detectedLanguage, languageScores };
}

async function resolveEffectiveWhisperLanguage(model, processor, audio, language, languagePriority) {
	const explicitLanguage = resolveWhisperLanguage(language);
	if (explicitLanguage) {
		return explicitLanguage;
	}

	try {
		const detection = await detectWhisperLanguage(model, processor, audio);
		if (detection) {
			return applyLanguageDetectionPriority(
				detection.detectedLanguage,
				detection.languageScores,
				languagePriority,
			);
		}
	} catch (err) {
		console.warn("[Whisper] Language detection failed:", err);
	}

	return resolveWhisperLanguage(languagePriority) ?? "en";
}

function isWebGpuFailure(err) {
	const message = String(err?.message ?? err ?? "");
	return (
		currentDevice === "webgpu" &&
		(message.includes("WebGPU") ||
			message.includes("JSEP") ||
			message.includes("FILTER_IN_CHANNEL") ||
			message.includes("Conv") ||
			message.includes("Failed to run JSEP"))
	);
}

function switchToWasm() {
	console.warn("[Whisper] WebGPU failed, switching to WASM (slower but stable)...");
	currentDevice = "wasm";
	AutomaticSpeechRecognitionPipeline.reset();
}

let liveProcessing = false;
let batchProcessing = false;

const WHISPER_CHUNK_LENGTH_S = 30;
const WHISPER_STRIDE_LENGTH_S = 5;

async function buildWhisperTimestampChunks(processor, audio, samplingRate) {
	const useChunking = audio.length > samplingRate * WHISPER_CHUNK_LENGTH_S;
	const chunks = [];

	if (useChunking) {
		const window = samplingRate * WHISPER_CHUNK_LENGTH_S;
		const stride = samplingRate * WHISPER_STRIDE_LENGTH_S;
		const jump = window - 2 * stride;
		let offset = 0;

		while (true) {
			const offsetEnd = offset + window;
			const subarr = audio.subarray(offset, Math.min(offsetEnd, audio.length));
			const feature = await processor(subarr);
			const isFirst = offset === 0;
			const isLast = offsetEnd >= audio.length;

			chunks.push({
				stride: [subarr.length, isFirst ? 0 : stride, isLast ? 0 : stride],
				input_features: feature.input_features,
			});

			if (isLast) break;
			offset += jump;
		}
	} else {
		const feature = await processor(audio);
		chunks.push({
			stride: [audio.length, 0, 0],
			input_features: feature.input_features,
		});
	}

	return chunks;
}

export async function setWhisperModel(modelId, device = "wasm") {
	currentModelId = modelId;
	currentDevice = device;
	AutomaticSpeechRecognitionPipeline.reset();
}

export async function processWhisperMessage(
	audio,
	language,
	task = "transcribe",
	modelId = null,
	languagePriority = null,
) {
	if (liveProcessing || batchProcessing) return;
	liveProcessing = true;
	if (!audio) {
		liveProcessing = false;
		return;
	}

	try {
		const [tokenizer, processor, model] = await AutomaticSpeechRecognitionPipeline.getInstance(
			null,
			modelId,
		);

		const streamer = new TextStreamer(tokenizer, { skip_prompt: true, skip_special_tokens: true });
		const inputs = await processor(audio);

		const generateOptions = {
			...inputs,
			max_new_tokens: MAX_NEW_TOKENS,
			task,
			streamer,
			do_sample: false,
			num_beams: 1,
		};

		const whisperLanguage = await resolveEffectiveWhisperLanguage(
			model,
			processor,
			audio,
			language,
			languagePriority,
		);
		if (whisperLanguage) {
			generateOptions.language = whisperLanguage;
		}

		const outputs = await model.generate(generateOptions);
		const outputText = tokenizer.batch_decode(outputs, { skip_special_tokens: true });
		liveProcessing = false;
		return outputText;
	} catch (err) {
		if (isWebGpuFailure(err)) {
			switchToWasm();
			liveProcessing = false;
			return processWhisperMessage(audio, language, task, modelId, languagePriority);
		}

		liveProcessing = false;
		safeRuntimeSendMessage({
			type: "model-status",
			data: { status: "error", message: String(err?.message ?? err) },
		});
		return null;
	}
}

export async function processWhisperWithTimestamps(
	audio,
	language,
	task = "transcribe",
	modelId = null,
	languagePriority = null,
) {
	if (batchProcessing || liveProcessing) return null;
	batchProcessing = true;
	if (!audio || audio.length === 0) {
		batchProcessing = false;
		return null;
	}

	try {
		const [tokenizer, processor, model] = await AutomaticSpeechRecognitionPipeline.getInstance(
			null,
			modelId,
		);

		const samplingRate = processor.feature_extractor.config.sampling_rate ?? WHISPER_SAMPLE_RATE;
		const hopLength = processor.feature_extractor.config.hop_length;
		const timePrecision =
			processor.feature_extractor.config.chunk_length / model.config.max_source_positions;

		const whisperChunks = await buildWhisperTimestampChunks(processor, audio, samplingRate);
		const durationSec = audio.length / samplingRate;
		const maxNewTokens = Math.max(256, Math.ceil(durationSec * 8));

		const whisperLanguage = await resolveEffectiveWhisperLanguage(
			model,
			processor,
			audio,
			language,
			languagePriority,
		);
		const generateBase = {
			max_new_tokens: maxNewTokens,
			return_timestamps: true,
			task,
			do_sample: false,
			num_beams: 1,
		};
		if (whisperLanguage) {
			generateBase.language = whisperLanguage;
		}

		for (const chunk of whisperChunks) {
			generateBase.num_frames = Math.floor(chunk.stride[0] / hopLength);
			const data = await model.generate({
				inputs: chunk.input_features,
				...generateBase,
			});
			chunk.tokens = data[0].tolist();
			chunk.stride = chunk.stride.map((value) => value / samplingRate);
		}

		const [fullText, optional] = tokenizer._decode_asr(whisperChunks, {
			return_timestamps: true,
			time_precision: timePrecision,
			force_full_sequences: true,
		});

		batchProcessing = false;
		return {
			text: fullText,
			chunks: optional?.chunks ?? [],
		};
	} catch (err) {
		if (isWebGpuFailure(err)) {
			switchToWasm();
			batchProcessing = false;
			return processWhisperWithTimestamps(audio, language, task, modelId, languagePriority);
		}

		batchProcessing = false;
		safeRuntimeSendMessage({
			type: "model-status",
			data: { status: "error", message: String(err?.message ?? err) },
		});
		return null;
	}
}

export async function initializeWhisperWorker(progress_callback, modelId = null) {
	try {
		const [_, processor, model] = await AutomaticSpeechRecognitionPipeline.getInstance(
			progress_callback,
			modelId,
		);
		// Warm up with processor-shaped features (80 mel bins), not a hard-coded [1, 128, 3000] tensor.
		const dummyAudio = new Float32Array(WHISPER_SAMPLE_RATE);
		const warmupInputs = await processor(dummyAudio);
		await model.generate({ ...warmupInputs, max_new_tokens: 1 });
	} catch (err) {
		if (isWebGpuFailure(err)) {
			switchToWasm();
			return initializeWhisperWorker(progress_callback, modelId);
		}

		AutomaticSpeechRecognitionPipeline.reset();
		safeRuntimeSendMessage({
			type: "model-status",
			data: { status: "error", message: String(err?.message ?? err) },
		});
		throw err;
	}
}