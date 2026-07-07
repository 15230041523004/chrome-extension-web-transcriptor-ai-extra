export type NewAudioSegment = {
	newAudio: Float32Array;
	totalSamples: number;
};

export const MIN_FLUSH_AUDIO_SAMPLES = 1_600; // 0.1s at 16 kHz

/**
 * Returns only the audio samples that have not been transcribed yet.
 * When the buffer exceeds maxWindowSamples, older audio is dropped but
 * transcribedSamples tracks the absolute stream position.
 */
export function extractNewAudioSegment(
	fullAudio: Float32Array,
	transcribedSamples: number,
	maxWindowSamples: number,
	minNewSamples = 0,
): NewAudioSegment | null {
	const totalSamples = fullAudio.length;
	if (totalSamples <= transcribedSamples) return null;

	const sliceOffset = totalSamples > maxWindowSamples ? totalSamples - maxWindowSamples : 0;
	const windowed = sliceOffset > 0 ? fullAudio.subarray(sliceOffset) : fullAudio;
	const newStartInWindow = Math.max(0, transcribedSamples - sliceOffset);
	const newAudio = windowed.subarray(newStartInWindow);

	if (newAudio.length === 0 || newAudio.length < minNewSamples) return null;

	return {
		newAudio: new Float32Array(newAudio),
		totalSamples,
	};
}