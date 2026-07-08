import { isDashPrefixedLine } from "./phraseChunks";

export type SpeakerSegment = {
	id: number;
	start: number;
	end: number;
	confidence: number;
};

export type TranscriptChunk = {
	text: string;
	timestamp: [number, number | null];
};

const FLICKER_MAX_SEC = 0.2;
const SAME_SPEAKER_GAP_SEC = 0.12;
const STICKY_GAP_SEC = 1.2;

function segmentDuration(segment: SpeakerSegment): number {
	return Math.max(0, segment.end - segment.start);
}

function chunkTimeRange(chunk: TranscriptChunk): [number, number] | null {
	const [start, end] = chunk.timestamp;
	if (start === null) return null;
	const effectiveEnd = end ?? start + 0.5;
	return [start, Math.max(effectiveEnd, start + 0.05)];
}

function chunkGapSec(previous: TranscriptChunk, next: TranscriptChunk): number {
	return next.timestamp[0] - (previous.timestamp[1] ?? previous.timestamp[0]);
}

function overlapDuration(
	segmentStart: number,
	segmentEnd: number,
	chunkStart: number,
	chunkEnd: number,
): number {
	const start = Math.max(segmentStart, chunkStart);
	const end = Math.min(segmentEnd, chunkEnd);
	return Math.max(0, end - start);
}

function mergeAdjacentSameSpeaker(segments: SpeakerSegment[], maxGapSec: number): SpeakerSegment[] {
	if (segments.length === 0) return [];

	const sorted = [...segments].sort((a, b) => a.start - b.start);
	const merged: SpeakerSegment[] = [{ ...sorted[0] }];

	for (let i = 1; i < sorted.length; i++) {
		const current = sorted[i];
		const last = merged[merged.length - 1];
		const gap = current.start - last.end;

		if (current.id === last.id && gap <= maxGapSec) {
			last.end = Math.max(last.end, current.end);
			const lastDur = segmentDuration(last);
			const currentDur = segmentDuration(current);
			const totalDur = lastDur + currentDur;
			last.confidence =
				totalDur > 0
					? (last.confidence * lastDur + current.confidence * currentDur) / totalDur
					: last.confidence;
		} else {
			merged.push({ ...current });
		}
	}

	return merged;
}

function collapseShortFlickers(segments: SpeakerSegment[], maxDurationSec: number): SpeakerSegment[] {
	if (segments.length < 3) return segments.map((segment) => ({ ...segment }));

	const relabeled = segments.map((segment) => ({ ...segment }));

	for (let i = 1; i < relabeled.length - 1; i++) {
		const prev = relabeled[i - 1];
		const current = relabeled[i];
		const next = relabeled[i + 1];

		if (
			segmentDuration(current) <= maxDurationSec &&
			prev.id === next.id &&
			current.id !== prev.id
		) {
			current.id = prev.id;
		}
	}

	return mergeAdjacentSameSpeaker(relabeled, 0);
}

export function smoothDiarizationSegments(segments: SpeakerSegment[]): SpeakerSegment[] {
	if (segments.length === 0) return [];

	const sorted = [...segments].sort((a, b) => a.start - b.start);
	const flickerFree = collapseShortFlickers(sorted, FLICKER_MAX_SEC);
	return mergeAdjacentSameSpeaker(flickerFree, SAME_SPEAKER_GAP_SEC);
}

function findSegmentAtTime(segments: SpeakerSegment[], timeSec: number): SpeakerSegment | null {
	for (const segment of segments) {
		if (timeSec >= segment.start && timeSec < segment.end) {
			return segment;
		}
	}
	return null;
}

export function assignSpeakerToChunk(
	chunk: TranscriptChunk,
	segments: SpeakerSegment[],
): number | null {
	const range = chunkTimeRange(chunk);
	if (!range || segments.length === 0) return null;

	const [chunkStart, chunkEnd] = range;
	const midpoint = (chunkStart + chunkEnd) / 2;
	const midpointSegment = findSegmentAtTime(segments, midpoint);
	if (midpointSegment) return midpointSegment.id;

	const chunkLen = Math.max(chunkEnd - chunkStart, 0.05);
	let bestId: number | null = null;
	let bestScore = 0;

	for (const segment of segments) {
		const overlap = overlapDuration(segment.start, segment.end, chunkStart, chunkEnd);
		const score = overlap / chunkLen;
		if (score > bestScore) {
			bestScore = score;
			bestId = segment.id;
		}
	}

	return bestId;
}

export function renumberSpeakersByTalkTime(
	rawIds: number[],
	segments: SpeakerSegment[],
): Map<number, number> {
	const durationById = new Map<number, number>();
	for (const segment of segments) {
		if (!rawIds.includes(segment.id)) continue;
		durationById.set(segment.id, (durationById.get(segment.id) ?? 0) + segmentDuration(segment));
	}

	const ranked = [...durationById.entries()].sort((a, b) => b[1] - a[1]);
	const mapping = new Map<number, number>();
	let next = 1;
	for (const [id] of ranked) {
		mapping.set(id, next++);
	}

	for (const id of rawIds) {
		if (!mapping.has(id)) {
			mapping.set(id, next++);
		}
	}

	return mapping;
}

function dedupeRepeatedPhrases(text: string): string {
	let result = text;

	for (let pass = 0; pass < 4; pass++) {
		const words = result.split(/\s+/);
		if (words.length < 8) break;

		let changed = false;
		const maxPhraseWords = Math.min(16, Math.floor(words.length / 2));

		for (let size = maxPhraseWords; size >= 5; size--) {
			for (let start = 0; start <= words.length - size * 2; start++) {
				const phrase = words.slice(start, start + size).join(" ");
				const repeat = words.slice(start + size, start + size * 2).join(" ");
				if (phrase.length > 20 && phrase === repeat) {
					result = [...words.slice(0, start + size), ...words.slice(start + size * 2)].join(" ");
					changed = true;
					break;
				}
			}
			if (changed) break;
		}

		if (!changed) {
			for (let size = maxPhraseWords; size >= 6; size--) {
				for (let start = 0; start <= words.length - size * 2; start++) {
					const phrase = words.slice(start, start + size).join(" ");
					if (phrase.length < 25) continue;
					const after = words.slice(start + size).join(" ");
					const overlapAt = after.indexOf(phrase);
					if (overlapAt >= 0) {
						const cleaned = `${words.slice(0, start + size).join(" ")} ${after.slice(0, overlapAt)}${after.slice(overlapAt + phrase.length)}`;
						result = cleaned.replace(/\s+/g, " ").trim();
						changed = true;
						break;
					}
				}
				if (changed) break;
			}
		}

		if (!changed) break;
	}

	return result;
}

function resolveDisplaySpeaker(
	rawSpeakerId: number | null,
	speakerLabels: Map<number, number>,
	lastSpeaker: number | null,
	previousChunk: TranscriptChunk | null,
	currentChunk: TranscriptChunk,
): number {
	if (rawSpeakerId !== null) {
		return speakerLabels.get(rawSpeakerId) ?? 1;
	}

	if (
		lastSpeaker !== null &&
		previousChunk !== null &&
		chunkGapSec(previousChunk, currentChunk) <= STICKY_GAP_SEC
	) {
		return lastSpeaker;
	}

	return lastSpeaker ?? 1;
}

export function mergeDiarizationWithTranscript(
	segments: SpeakerSegment[],
	chunks: TranscriptChunk[],
): string {
	const smoothedSegments = smoothDiarizationSegments(segments);

	const validChunks = chunks
		.map((chunk) => ({ chunk, text: chunk.text.trim() }))
		.filter(({ text }) => text.length > 0);

	if (validChunks.length === 0) return "";

	const assigned = validChunks.map(({ chunk, text }) => ({
		chunk,
		text,
		rawSpeakerId: assignSpeakerToChunk(chunk, smoothedSegments),
	}));

	const allSegmentIds = [...new Set(smoothedSegments.map((segment) => segment.id))];
	const speakerLabels = renumberSpeakersByTalkTime(allSegmentIds, smoothedSegments);

	const lines: { speaker: number; text: string }[] = [];
	let previousChunk: TranscriptChunk | null = null;

	for (const { chunk, text, rawSpeakerId } of assigned) {
		const last = lines.length > 0 ? lines[lines.length - 1] : undefined;
		const speaker = resolveDisplaySpeaker(
			rawSpeakerId,
			speakerLabels,
			last?.speaker ?? null,
			previousChunk,
			chunk,
		);

		const canMergeWithLast =
			last &&
			last.speaker === speaker &&
			!isDashPrefixedLine(text) &&
			!isDashPrefixedLine(last.text);

		if (canMergeWithLast) {
			last.text = `${last.text} ${text}`.trim();
		} else {
			lines.push({ speaker, text });
		}

		previousChunk = chunk;
	}

	if (lines.length === 0) {
		return validChunks.map(({ text }) => text).join(" ").trim();
	}

	return lines
		.map(({ speaker, text }) => `Speaker ${speaker}: ${dedupeRepeatedPhrases(text)}`)
		.join("\n");
}