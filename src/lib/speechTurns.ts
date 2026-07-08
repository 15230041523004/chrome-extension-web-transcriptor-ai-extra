import type { SpeakerSegment } from "./mergeDiarization";
import {
	assignSpeakersByPause,
	diarizeTurnsWithEmbeddings,
	type SpeechTurn,
} from "./speakerEmbeddings";

const SAMPLE_RATE = 16_000;
const FRAME_SEC = 0.02;
const MIN_SILENCE_SEC = 0.36;
const MIN_SPEECH_SEC = 0.18;
const ENERGY_PERCENTILE = 0.55;

function frameRms(audio: Float32Array, start: number, end: number): number {
	let sum = 0;
	for (let i = start; i < end; i++) {
		sum += audio[i] * audio[i];
	}
	return Math.sqrt(sum / Math.max(1, end - start));
}

export function detectSpeechTurns(audio: Float32Array, sampleRate = SAMPLE_RATE): SpeechTurn[] {
	if (audio.length === 0) return [];

	const frameSize = Math.max(1, Math.floor(sampleRate * FRAME_SEC));
	const minSilenceFrames = Math.max(1, Math.ceil(MIN_SILENCE_SEC / FRAME_SEC));
	const minSpeechFrames = Math.max(1, Math.ceil(MIN_SPEECH_SEC / FRAME_SEC));

	const energies: number[] = [];
	for (let offset = 0; offset < audio.length; offset += frameSize) {
		const end = Math.min(offset + frameSize, audio.length);
		energies.push(frameRms(audio, offset, end));
	}

	const sorted = [...energies].sort((a, b) => a - b);
	const percentileIndex = Math.min(
		sorted.length - 1,
		Math.floor(sorted.length * ENERGY_PERCENTILE),
	);
	const threshold = Math.max(sorted[percentileIndex] * 2.2, 0.004);

	const turns: SpeechTurn[] = [];
	let speechStart: number | null = null;
	let silenceRun = 0;
	let speechRun = 0;

	const flushSpeech = (endFrame: number) => {
		if (speechStart === null) return;
		const startSec = speechStart * frameSize / sampleRate;
		const endSec = Math.min(audio.length / sampleRate, endFrame * frameSize / sampleRate);
		if (endSec - startSec >= MIN_SPEECH_SEC) {
			turns.push({ start: startSec, end: endSec });
		}
		speechStart = null;
		speechRun = 0;
	};

	for (let frame = 0; frame < energies.length; frame++) {
		const isSpeech = energies[frame] >= threshold;

		if (isSpeech) {
			silenceRun = 0;
			speechRun++;
			if (speechStart === null) {
				speechStart = frame;
			}
			continue;
		}

		silenceRun++;
		if (speechStart !== null && silenceRun >= minSilenceFrames && speechRun >= minSpeechFrames) {
			flushSpeech(frame - silenceRun);
		}
	}

	if (speechStart !== null) {
		flushSpeech(energies.length);
	}

	return turns;
}

export async function buildSpeakerSegmentsFromAudio(
	audio: Float32Array,
	progress_callback?: (progress: unknown) => void,
): Promise<SpeakerSegment[]> {
	const turns = detectSpeechTurns(audio);
	if (turns.length === 0) return [];

	try {
		return await diarizeTurnsWithEmbeddings(audio, turns, progress_callback);
	} catch (err) {
		console.warn("Embedding diarization failed, using pause alternation:", err);
		return assignSpeakersByPause(turns);
	}
}

export type { SpeechTurn };