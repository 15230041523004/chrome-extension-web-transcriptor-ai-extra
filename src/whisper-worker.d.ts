/* eslint-disable @typescript-eslint/no-explicit-any */
export declare module "./whisper-worker.js" {
	export type WhisperTimestampChunk = {
		text: string;
		timestamp: [number, number | null];
		words?: Array<{
			text: string;
			timestamp: [number, number | null];
		}>;
	};

	export type WhisperTimestampResult = {
		text: string;
		chunks: WhisperTimestampChunk[];
	};

	export declare function processWhisperMessage(
		audio: Float32Array,
		language: string | null,
		task: "transcribe" | "translate",
		modelId?: string | null,
		languagePriority?: string | null,
	): Promise<any>;
	export declare function processWhisperWithTimestamps(
		audio: Float32Array,
		language: string | null,
		task: "transcribe" | "translate",
		modelId?: string | null,
		languagePriority?: string | null,
	): Promise<WhisperTimestampResult | null>;
	export declare function initializeWhisperWorker(
		progressCallbackFunc: (progress: unknown) => void,
		modelId?: string | null,
	): Promise<void>;
}