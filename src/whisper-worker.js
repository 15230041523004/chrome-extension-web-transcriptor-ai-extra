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

class AutomaticSpeechRecognitionPipeline {
	static model_id = null;
	static tokenizer = null;
	static processor = null;
	static model = null;

	static async getInstance(progress_callback = null, modelId = null) {
		if (modelId) currentModelId = modelId;
		this.model_id = currentModelId;

		this.tokenizer ??= AutoTokenizer.from_pretrained(this.model_id, { progress_callback });
		this.processor ??= AutoProcessor.from_pretrained(this.model_id, { progress_callback });

		this.model ??= WhisperForConditionalGeneration.from_pretrained(this.model_id, {
			dtype: "fp32",
			device: "webgpu",
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

export async function setWhisperModel(modelId) {
	currentModelId = modelId;
	// Reset pipeline so it reloads with new model
	AutomaticSpeechRecognitionPipeline.tokenizer = null;
	AutomaticSpeechRecognitionPipeline.processor = null;
	AutomaticSpeechRecognitionPipeline.model = null;
}

export async function processWhisperMessage(audio, language, task = "transcribe", modelId = null) {
	if (processing) return;
	processing = true;
	if (!audio) { processing = false; return; }

	const whisperLanguage = language ? toWhisperLanguage(language) : null;

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
		chrome.runtime.sendMessage({ type: "model-status", data: { status: "error", message: err.message } });
	}
}
