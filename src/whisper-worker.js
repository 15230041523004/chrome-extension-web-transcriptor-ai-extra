/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-unused-vars */
import {
	AutoProcessor,
	AutoTokenizer,
	TextStreamer,
	WhisperForConditionalGeneration,
	full,
} from "@huggingface/transformers";

const MAX_NEW_TOKENS = 128;

let currentModelId = "onnx-community/whisper-base";
let currentDevice = "webgpu";

class AutomaticSpeechRecognitionPipeline {
	static model_id = null;
	static tokenizer = null;
	static processor = null;
	static model = null;

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

let processing = false;

export async function setWhisperModel(modelId, device = "webgpu") {
	currentModelId = modelId;
	currentDevice = device;
	AutomaticSpeechRecognitionPipeline.tokenizer = null;
	AutomaticSpeechRecognitionPipeline.processor = null;
	AutomaticSpeechRecognitionPipeline.model = null;
}

export async function processWhisperMessage(audio, language, task = "transcribe", modelId = null) {
	if (processing) return;
	processing = true;
	if (!audio) { processing = false; return; }

	const whisperLanguage = language || "ru"; // force Russian

	try {
		const [tokenizer, processor, model] = await AutomaticSpeechRecognitionPipeline.getInstance(null, modelId);

		const streamer = new TextStreamer(tokenizer, { skip_prompt: true, skip_special_tokens: true });
		const inputs = await processor(audio);

		const outputs = await model.generate({
			...inputs,
			max_new_tokens: MAX_NEW_TOKENS,
			task,
			language: whisperLanguage,
			streamer,
			do_sample: false,
			num_beams: 1,
		});

		const outputText = tokenizer.batch_decode(outputs, { skip_special_tokens: true });
		processing = false;
		return outputText;
	} catch (err) {
		// Fallback to WASM if WebGPU/JSEP fails
		if (currentDevice === "webgpu" && (err.message?.includes("WebGPU") || err.message?.includes("JSEP") || err.message?.includes("FILTER_IN_CHANNEL") || err.message?.includes("Conv"))) {
			console.warn("[Whisper] WebGPU failed, falling back to WASM (slower but stable)...");
			currentDevice = "wasm";
			AutomaticSpeechRecognitionPipeline.tokenizer = null;
			AutomaticSpeechRecognitionPipeline.processor = null;
			AutomaticSpeechRecognitionPipeline.model = null;
			return processWhisperMessage(audio, language, task, modelId);
		}

		processing = false;
		chrome.runtime.sendMessage({ type: "model-status", data: { status: "error", message: err.message } });
		return null;
	}
}

export async function initializeWhisperWorker(progress_callback, modelId = null) {
	try {
		const [_, __, model] = await AutomaticSpeechRecognitionPipeline.getInstance(progress_callback, modelId);
		await model.generate({ input_features: full([1, 128, 3000], 0.0), max_new_tokens: 1 });
	} catch (err) {
		if (currentDevice === "webgpu" && (err.message?.includes("WebGPU") || err.message?.includes("JSEP"))) {
			console.warn("[Whisper] WebGPU init failed, switching to WASM");
			currentDevice = "wasm";
			AutomaticSpeechRecognitionPipeline.tokenizer = null;
			AutomaticSpeechRecognitionPipeline.processor = null;
			AutomaticSpeechRecognitionPipeline.model = null;
			return initializeWhisperWorker(progress_callback, modelId);
		}
		chrome.runtime.sendMessage({ type: "model-status", data: { status: "error", message: err.message } });
	}
}
