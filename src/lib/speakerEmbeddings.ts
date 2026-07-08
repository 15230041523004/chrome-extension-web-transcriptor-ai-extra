import { AutoModel, AutoProcessor } from "@huggingface/transformers";
import type { SpeakerSegment } from "./mergeDiarization";

const EMBEDDING_MODEL_ID = "Xenova/wavlm-base-plus-sv";
const SAMPLE_RATE = 16_000;
const MIN_EMBED_SEC = 0.25;
const MIN_EMBED_SAMPLES = Math.floor(SAMPLE_RATE * 0.35);
const MAX_EMBED_SEC = 12;
const MAX_EMBED_SAMPLES = Math.floor(SAMPLE_RATE * MAX_EMBED_SEC);
const MAX_TURNS_TO_EMBED = 40;
const LINK_THRESHOLD = 0.82;
const MAX_SEGMENTS_PER_ID = 3;
const SPEAKER_COUNT = 3;
const SAME_SPEAKER_SIM = 0.76;
const TURN_CHANGE_PAUSE_SEC = 0.34;

type ProgressCallback = (progress: unknown) => void;

export type SpeechTurn = {
	start: number;
	end: number;
};

class SpeakerEmbeddingPipeline {
	static processor: ReturnType<typeof AutoProcessor.from_pretrained> | null = null;
	static model: ReturnType<typeof AutoModel.from_pretrained> | null = null;

	static reset() {
		this.processor = null;
		this.model = null;
	}

	static async getInstance(progress_callback?: ProgressCallback) {
		this.processor ??= AutoProcessor.from_pretrained(EMBEDDING_MODEL_ID, { progress_callback });
		this.model ??= AutoModel.from_pretrained(EMBEDDING_MODEL_ID, {
			device: "wasm",
			progress_callback,
		});
		return Promise.all([this.processor, this.model]);
	}
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom > 0 ? dot / denom : 0;
}

function averageEmbeddings(embeddings: Float32Array[]): Float32Array | null {
	if (embeddings.length === 0) return null;
	const size = embeddings[0].length;
	const avg = new Float32Array(size);
	for (const embedding of embeddings) {
		for (let i = 0; i < size; i++) {
			avg[i] += embedding[i];
		}
	}
	for (let i = 0; i < size; i++) {
		avg[i] /= embeddings.length;
	}
	return avg;
}

function sliceAudioForEmbedding(
	audio: Float32Array,
	startSec: number,
	endSec: number,
): Float32Array | null {
	if (endSec - startSec < MIN_EMBED_SEC) return null;

	let startSample = Math.max(0, Math.floor(startSec * SAMPLE_RATE));
	let endSample = Math.min(audio.length, Math.ceil(endSec * SAMPLE_RATE));

	if (endSample - startSample < MIN_EMBED_SAMPLES) {
		const center = Math.floor((startSample + endSample) / 2);
		const half = Math.floor(MIN_EMBED_SAMPLES / 2);
		startSample = Math.max(0, center - half);
		endSample = Math.min(audio.length, startSample + MIN_EMBED_SAMPLES);
		if (endSample - startSample < MIN_EMBED_SAMPLES) {
			startSample = Math.max(0, endSample - MIN_EMBED_SAMPLES);
		}
	}

	if (endSample - startSample < MIN_EMBED_SAMPLES) return null;

	if (endSample - startSample > MAX_EMBED_SAMPLES) {
		const center = Math.floor((startSample + endSample) / 2);
		const half = Math.floor(MAX_EMBED_SAMPLES / 2);
		startSample = Math.max(0, center - half);
		endSample = Math.min(audio.length, startSample + MAX_EMBED_SAMPLES);
	}

	return audio.subarray(startSample, endSample);
}

async function extractAudioEmbedding(
	audio: Float32Array,
	startSec: number,
	endSec: number,
	processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>,
	model: Awaited<ReturnType<typeof AutoModel.from_pretrained>>,
): Promise<Float32Array | null> {
	const slice = sliceAudioForEmbedding(audio, startSec, endSec);
	if (!slice) return null;

	try {
		const inputs = await processor(slice);
		const outputs = (await model(inputs)) as {
			embeddings?: { data: Float32Array | number[] };
			logits?: { data: Float32Array | number[] };
		};
		const tensor = outputs.embeddings ?? outputs.logits;
		if (!tensor) return null;

		const data = tensor.data;
		return data instanceof Float32Array ? data : new Float32Array(data);
	} catch (err) {
		console.warn("Speaker embedding extraction failed:", err);
		return null;
	}
}

function pickTurnsForEmbedding(turns: SpeechTurn[]): { turn: SpeechTurn; index: number }[] {
	if (turns.length <= MAX_TURNS_TO_EMBED) {
		return turns.map((turn, index) => ({ turn, index }));
	}

	const picked: { turn: SpeechTurn; index: number }[] = [];
	const step = turns.length / MAX_TURNS_TO_EMBED;
	for (let slot = 0; slot < MAX_TURNS_TO_EMBED; slot++) {
		const index = Math.min(turns.length - 1, Math.floor(slot * step));
		picked.push({ turn: turns[index], index });
	}
	return picked;
}

function kMeansAssign(embeddings: Float32Array[], k: number, maxIterations = 24): number[] {
	if (embeddings.length === 0) return [];
	if (embeddings.length <= k) {
		return embeddings.map((_, index) => index);
	}

	const dim = embeddings[0].length;
	const centroids: Float32Array[] = [embeddings[0].slice()];

	for (let c = 1; c < k; c++) {
		let farthestIndex = 0;
		let farthestDistance = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < embeddings.length; i++) {
			let minDistance = Number.POSITIVE_INFINITY;
			for (const centroid of centroids) {
				const similarity = cosineSimilarity(embeddings[i], centroid);
				const distance = 1 - similarity;
				minDistance = Math.min(minDistance, distance);
			}
			if (minDistance > farthestDistance) {
				farthestDistance = minDistance;
				farthestIndex = i;
			}
		}
		centroids.push(embeddings[farthestIndex].slice());
	}

	const assignments = new Array(embeddings.length).fill(0);

	for (let iter = 0; iter < maxIterations; iter++) {
		let changed = false;
		const counts = new Array(k).fill(0);
		const sums = Array.from({ length: k }, () => new Float32Array(dim));

		for (let i = 0; i < embeddings.length; i++) {
			let bestCluster = 0;
			let bestSimilarity = Number.NEGATIVE_INFINITY;
			for (let c = 0; c < k; c++) {
				const similarity = cosineSimilarity(embeddings[i], centroids[c]);
				if (similarity > bestSimilarity) {
					bestSimilarity = similarity;
					bestCluster = c;
				}
			}
			if (assignments[i] !== bestCluster) {
				assignments[i] = bestCluster;
				changed = true;
			}
			counts[bestCluster]++;
			for (let d = 0; d < dim; d++) {
				sums[bestCluster][d] += embeddings[i][d];
			}
		}

		for (let c = 0; c < k; c++) {
			if (counts[c] === 0) continue;
			for (let d = 0; d < dim; d++) {
				centroids[c][d] = sums[c][d] / counts[c];
			}
		}

		if (!changed) break;
	}

	return assignments;
}

function refineTurnSpeakers(
	turns: SpeechTurn[],
	embeddings: (Float32Array | null)[],
	labels: number[],
): number[] {
	const refined = [...labels];

	for (let i = 1; i < turns.length; i++) {
		const pause = turns[i].start - turns[i - 1].end;
		const prevEmbedding = embeddings[i - 1];
		const currentEmbedding = embeddings[i];

		if (pause < 0.2) {
			refined[i] = refined[i - 1];
			continue;
		}

		if (prevEmbedding && currentEmbedding) {
			const similarity = cosineSimilarity(prevEmbedding, currentEmbedding);
			if (similarity >= SAME_SPEAKER_SIM) {
				refined[i] = refined[i - 1];
			} else if (pause >= TURN_CHANGE_PAUSE_SEC) {
				refined[i] = refined[i - 1] === 0 ? 1 : 0;
			}
			continue;
		}

		if (pause >= TURN_CHANGE_PAUSE_SEC) {
			refined[i] = refined[i - 1] === 0 ? 1 : 0;
		} else {
			refined[i] = refined[i - 1];
		}
	}

	return refined;
}

export function assignSpeakersByPause(turns: SpeechTurn[]): SpeakerSegment[] {
	if (turns.length === 0) return [];

	const labels = refineTurnSpeakers(
		turns,
		turns.map(() => null),
		turns.map(() => 0),
	);

	return turns.map((turn, index) => ({
		id: labels[index],
		start: turn.start,
		end: turn.end,
		confidence: 0.45,
	}));
}

export async function diarizeTurnsWithEmbeddings(
	audio: Float32Array,
	turns: SpeechTurn[],
	progress_callback?: ProgressCallback,
): Promise<SpeakerSegment[]> {
	if (turns.length === 0) return [];

	const [processor, model] = await SpeakerEmbeddingPipeline.getInstance(progress_callback);
	const turnEmbeddings: (Float32Array | null)[] = turns.map(() => null);
	const pickedTurns = pickTurnsForEmbedding(turns);

	for (const { turn, index } of pickedTurns) {
		turnEmbeddings[index] = await extractAudioEmbedding(
			audio,
			turn.start,
			turn.end,
			processor,
			model,
		);
	}

	const validEmbeddings = turnEmbeddings.filter((embedding): embedding is Float32Array => embedding !== null);
	let speakerByTurn = turns.map(() => 0);

	if (validEmbeddings.length >= 2) {
		const clusterLabels = kMeansAssign(
			validEmbeddings,
			Math.min(SPEAKER_COUNT, validEmbeddings.length),
		);
		let clusterIndex = 0;
		for (let i = 0; i < turnEmbeddings.length; i++) {
			if (turnEmbeddings[i]) {
				speakerByTurn[i] = clusterLabels[clusterIndex++];
			}
		}
	}

	speakerByTurn = refineTurnSpeakers(turns, turnEmbeddings, speakerByTurn);

	return turns.map((turn, index) => ({
		id: speakerByTurn[index],
		start: turn.start,
		end: turn.end,
		confidence: turnEmbeddings[index] ? 0.9 : 0.5,
	}));
}

function findCanonicalId(parent: Map<number, number>, id: number): number {
	let current = id;
	while (parent.get(current) !== current) {
		current = parent.get(current) ?? current;
	}
	let node = id;
	while (parent.get(node) !== node) {
		const next = parent.get(node) ?? node;
		parent.set(node, current);
		node = next;
	}
	return current;
}

function uniteIds(parent: Map<number, number>, a: number, b: number) {
	const rootA = findCanonicalId(parent, a);
	const rootB = findCanonicalId(parent, b);
	if (rootA !== rootB) {
		parent.set(rootB, rootA);
	}
}

/** @deprecated Kept for fallback; primary path uses pause-based turns. */
export async function linkPyannoteSpeakerIds(
	audio: Float32Array,
	segments: SpeakerSegment[],
	progress_callback?: ProgressCallback,
): Promise<SpeakerSegment[]> {
	if (segments.length === 0) return [];

	const sorted = [...segments].sort((a, b) => a.start - b.start);
	const uniqueIds = [...new Set(sorted.map((segment) => segment.id))];
	if (uniqueIds.length <= 1) return sorted;

	const segmentsById = new Map<number, SpeakerSegment[]>();
	for (const segment of sorted) {
		const group = segmentsById.get(segment.id) ?? [];
		group.push(segment);
		segmentsById.set(segment.id, group);
	}

	const [processor, model] = await SpeakerEmbeddingPipeline.getInstance(progress_callback);
	const idEmbeddings = new Map<number, Float32Array>();

	for (const id of uniqueIds) {
		const candidates = (segmentsById.get(id) ?? [])
			.filter((segment) => segment.end - segment.start >= MIN_EMBED_SEC)
			.sort((a, b) => b.end - b.start - (a.end - a.start))
			.slice(0, MAX_SEGMENTS_PER_ID);

		const embeddings: Float32Array[] = [];
		for (const segment of candidates) {
			const embedding = await extractAudioEmbedding(
				audio,
				segment.start,
				segment.end,
				processor,
				model,
			);
			if (embedding) embeddings.push(embedding);
		}

		const averaged = averageEmbeddings(embeddings);
		if (averaged) {
			idEmbeddings.set(id, averaged);
		}
	}

	if (idEmbeddings.size < 2) return sorted;

	const parent = new Map<number, number>();
	for (const id of uniqueIds) {
		parent.set(id, id);
	}

	const embeddableIds = [...idEmbeddings.keys()];
	for (let i = 0; i < embeddableIds.length; i++) {
		for (let j = i + 1; j < embeddableIds.length; j++) {
			const idA = embeddableIds[i];
			const idB = embeddableIds[j];
			const similarity = cosineSimilarity(idEmbeddings.get(idA)!, idEmbeddings.get(idB)!);
			if (similarity >= LINK_THRESHOLD) {
				uniteIds(parent, idA, idB);
			}
		}
	}

	return sorted.map((segment) => ({
		...segment,
		id: findCanonicalId(parent, segment.id),
	}));
}

export async function initializeSpeakerEmbeddings(progress_callback?: ProgressCallback) {
	await SpeakerEmbeddingPipeline.getInstance(progress_callback);
}

export function resetSpeakerEmbeddings() {
	SpeakerEmbeddingPipeline.reset();
}