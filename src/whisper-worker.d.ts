/* eslint-disable @typescript-eslint/no-explicit-any */
export declare module "./whisper-worker.js" {
	export declare function processWhisperMessage(
		audio: Float32Array,
		language: string | null,
		task: "transcribe" | "translate",
		modelId?: string | null,
		// biome-ignore lint/suspicious/noExplicitAny: Whisper returns transcription result object
	): Promise<any>;
	export declare function initializeWhisperWorker(
		progressCallbackFunc: (progress: unknown) => void,
		modelId?: string | null,
	): Promise<void>;
}
