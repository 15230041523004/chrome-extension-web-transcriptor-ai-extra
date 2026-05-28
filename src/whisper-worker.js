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

/**
 * This class uses the Singleton pattern to ensure that only one instance of the model is loaded.
 */

// biome-ignore lint/complexity/noStaticOnlyClass: Singleton pattern for model loading
class AutomaticSpeechRecognitionPipeline {
	static model_id = null;
	static tokenizer = null;
	static processor = null;
	static model = null;

	static async getInstance(progress_callback = null) {
		// Changed to medium for better Russian support
		this.model_id = "onnx-community/whisper-medium";

		AutomaticSpeechRecognitionPipeline;
		AutomaticSpeechRecognitionPipeline.tokenizer ??=
			AutoTokenizer.from_pretrained(this.model_id, {
				progress_callback,
			});
		this.processor ??= AutoProcessor.from_pretrained(this.model_id, {
			progress_callback,
		});

		this.model ??= WhisperForConditionalGeneration.from_pretrained(
			this.model_id,
			{
				dtype: {
					encoder_model: "fp16",
					decoder_model_merged: "q4",
				},
				device: "webgpu",
				progress_callback,
			},
		);
		return Promise.all([this.tokenizer, this.processor, this.model]);
	}
}

/**
 * Convert UI language format to Whisper format.
 */
function toWhisperLanguage(language) {
	if (!language || typeof language !== "string") return language;
	return language.includes("/") ? language.split("/")[0].trim() : language;
}

let processing = false;

export async function processWhisperMessage(audio, language, task = "transcribe") {
	if (processing) return;
	processing = true;
	if (!audio) {
		console.debug("No audio data provided.");
		processing = false;
		return;
	}

	const whisperLanguage = language ? toWhisperLanguage(language) : null;
	console.debug("processWhisperMessage → task:", task, "language:", whisperLanguage);

	const [tokenizer, processor, model] =
		await AutomaticSpeechRecognitionPipeline.getInstance((data) => {
			if (
				data.status === "progress" &&
				Math.ceil(data.progress * 100) % 10 === 0
			) {
				console.debug(`Model loading: ${data.progress}%`);
				chrome.runtime.sendMessage({ type: "whisper-progress", data });
			}
		});

	const streamer = new TextStreamer(tokenizer, {
		skip_prompt: true,
		skip_special_tokens: true,
	});

	const inputs = await processor(audio);

	const outputs = await model.generate({
		...inputs,
		max_new_tokens: MAX_NEW_TOKENS,
		task: task,                    // Hard fixed
		language: whisperLanguage,     // Hard fixed for Russian
		streamer,
		do_sample: false,
		num_beams: 1,
	});

	const outputText = tokenizer.batch_decode(outputs, {
		skip_special_tokens: true,
	});

	console.debug("outputText", outputText);
	processing = false;
	return outputText;
}

export async function initializeWhisperWorker(progress_callback) {
	const [_tokenizer, _processor, model] =
		await AutomaticSpeechRecognitionPipeline.getInstance((data) => {
			if (
				data.status === "progress" &&
				Math.ceil(data.progress * 100) % 10 === 0
			) {
				progress_callback(data.progress);
			}
		});

	await model.generate({
		input_features: full([1, 128, 3000], 0.0),
		max_new_tokens: 1,
	});
}
