import type { TranscriptChunk } from "./mergeDiarization";

const PHRASE_GAP_SEC = 0.32;
const DASH_SPLIT = /\s+[-–—]\s+/;

type WhisperChunk = {
	text?: string;
	timestamp?: [number, number | null];
};

export function isDashPrefixedLine(text: string): boolean {
	return /^[-–—]/.test(text.trim());
}

function isSentenceEndBeforeDash(before: string): boolean {
	return /[.?!…:]\s*$/.test(before.trim());
}

function splitOnDashes(text: string): string[] | null {
	if (!/[-–—]/.test(text)) return null;

	const rawParts = text.split(DASH_SPLIT).map((part) => part.trim()).filter(Boolean);
	if (rawParts.length <= 1) return null;

	const merged: string[] = [rawParts[0]];
	for (let i = 1; i < rawParts.length; i++) {
		const before = merged[merged.length - 1];
		const after = rawParts[i];
		if (isSentenceEndBeforeDash(before)) {
			merged.push(after);
		} else {
			merged[merged.length - 1] = `${before} - ${after}`;
		}
	}

	if (merged.length <= 1) return null;

	return merged.map((part, index) => {
		if (index === 0 && !/^[-–—]/.test(text.trim())) return part;
		return part.startsWith("-") ? part : `- ${part}`;
	});
}

function splitChunkByTime(start: number, end: number, parts: string[]): TranscriptChunk[] {
	const weights = parts.map((part) => Math.max(part.length, 1));
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
	const duration = Math.max(end - start, 0.05 * parts.length);

	let cursor = start;
	return parts.map((part, index) => {
		const sliceDuration =
			index === parts.length - 1 ? end - cursor : (duration * weights[index]) / totalWeight;
		const sliceStart = cursor;
		const sliceEnd = index === parts.length - 1 ? end : cursor + sliceDuration;
		cursor = sliceEnd;

		return {
			text: part.trim(),
			timestamp: [sliceStart, sliceEnd],
		};
	});
}

function normalizeSegmentChunk(chunk: WhisperChunk): TranscriptChunk[] {
	const text = chunk.text?.trim();
	const timestamp = chunk.timestamp;
	if (!text || !timestamp) return [];

	const [start, endRaw] = timestamp;
	if (start === null || start === undefined) return [];

	const end = endRaw ?? start + 0.5;
	const parts = splitOnDashes(text);

	if (parts) {
		return splitChunkByTime(start, end, parts);
	}

	return [{ text, timestamp: [start, end] }];
}

function groupByPause(chunks: TranscriptChunk[]): TranscriptChunk[] {
	if (chunks.length === 0) return [];

	const phrases: TranscriptChunk[] = [];
	let current = { ...chunks[0], text: chunks[0].text };

	for (let i = 1; i < chunks.length; i++) {
		const next = chunks[i];
		const gap = next.timestamp[0] - (current.timestamp[1] ?? current.timestamp[0]);
		const dashBoundary = isDashPrefixedLine(next.text) || isDashPrefixedLine(current.text);

		if (gap > PHRASE_GAP_SEC || dashBoundary) {
			phrases.push({
				text: current.text.trim(),
				timestamp: [current.timestamp[0], current.timestamp[1]],
			});
			current = { ...next, text: next.text };
		} else {
			current.text = `${current.text} ${next.text}`.trim();
			current.timestamp = [current.timestamp[0], next.timestamp[1] ?? next.timestamp[0]];
		}
	}

	phrases.push({
		text: current.text.trim(),
		timestamp: [current.timestamp[0], current.timestamp[1]],
	});

	return phrases.filter((phrase) => phrase.text.length > 0);
}

export function buildPhraseChunks(rawChunks: WhisperChunk[]): TranscriptChunk[] {
	const segmentChunks = rawChunks.flatMap((chunk) => normalizeSegmentChunk(chunk));
	if (segmentChunks.length === 0) return [];
	return groupByPause(segmentChunks);
}