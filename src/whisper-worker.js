/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-unused-vars */
import {
	AutoProcessor,
	AutoTokenizer,
	TextStreamer,
	WhisperForConditionalGeneration,
} from "@huggingface/transformers";

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

let processing = false;

export async function setWhisperModel(modelId, device = "wasm") {
	currentModelId = modelId;
	currentDevice = device;
	AutomaticSpeechRecognitionPipeline.reset();
}

export async function processWhisperMessage(audio, language, task = "transcribe", modelId = null) {
	if (processing) return;
	processing = true;
	if (!audio) {
		processing = false;
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

		const whisperLanguage = resolveWhisperLanguage(language);
		if (whisperLanguage) {
			generateOptions.language = whisperLanguage;
		}

		const outputs = await model.generate(generateOptions);
		const outputText = tokenizer.batch_decode(outputs, { skip_special_tokens: true });
		processing = false;
		return outputText;
	} catch (err) {
		if (isWebGpuFailure(err)) {
			switchToWasm();
			processing = false;
			return processWhisperMessage(audio, language, task, modelId);
		}

		processing = false;
		chrome.runtime.sendMessage({
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
		chrome.runtime.sendMessage({
			type: "model-status",
			data: { status: "error", message: String(err?.message ?? err) },
		});
		throw err;
	}
}