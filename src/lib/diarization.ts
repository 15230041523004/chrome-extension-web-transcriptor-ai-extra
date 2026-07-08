import {
	AutoModelForAudioFrameClassification,
	AutoProcessor,
} from "@huggingface/transformers";
import type { SpeakerSegment } from "./mergeDiarization";

const DIARIZATION_MODEL_ID = "onnx-community/pyannote-segmentation-3.0";

type ProgressCallback = (progress: unknown) => void;

type DiarizationProcessor = Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> & {
	post_process_speaker_diarization: (
		logits: unknown,
		audioLength: number,
	) => SpeakerSegment[][];
};

class DiarizationPipeline {
	static processor: ReturnType<typeof AutoProcessor.from_pretrained> | null = null;
	static model: ReturnType<typeof AutoModelForAudioFrameClassification.from_pretrained> | null =
		null;

	static reset() {
		this.processor = null;
		this.model = null;
	}

	static async getInstance(progress_callback?: ProgressCallback) {
		this.processor ??= AutoProcessor.from_pretrained(DIARIZATION_MODEL_ID, { progress_callback });
		this.model ??= AutoModelForAudioFrameClassification.from_pretrained(DIARIZATION_MODEL_ID, {
			device: "wasm",
			progress_callback,
		});
		return Promise.all([this.processor, this.model]);
	}
}

export async function initializeDiarization(progress_callback?: ProgressCallback) {
	await DiarizationPipeline.getInstance(progress_callback);
}

export async function runSpeakerDiarization(audio: Float32Array): Promise<SpeakerSegment[]> {
	const [processor, model] = await DiarizationPipeline.getInstance();
	const diarizationProcessor = processor as DiarizationProcessor;
	const inputs = await diarizationProcessor(audio);
	const { logits } = await model(inputs);
	const results = diarizationProcessor.post_process_speaker_diarization(logits, audio.length);
	return results[0] ?? [];
}

export function resetDiarization() {
	DiarizationPipeline.reset();
}