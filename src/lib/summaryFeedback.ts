/**
 * Lightweight summary feedback for offline analysis (Phase A5).
 * No in-browser training — export only.
 */

const STORAGE_KEY = "summaryFeedbackEntries";
const MAX_ENTRIES = 100;

export type SummaryFeedbackEntry = {
	videoId?: string | null;
	title?: string;
	summary: string;
	rating: 1 | -1;
	unitCount?: number;
	timestamp: number;
};

function hasChromeLocalStorage(): boolean {
	return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

async function readAll(): Promise<SummaryFeedbackEntry[]> {
	if (hasChromeLocalStorage()) {
		return new Promise((resolve) => {
			try {
				chrome.storage.local.get(STORAGE_KEY, (result) => {
					const raw = result?.[STORAGE_KEY];
					resolve(Array.isArray(raw) ? (raw as SummaryFeedbackEntry[]) : []);
				});
			} catch {
				resolve([]);
			}
		});
	}
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return [];
		const parsed = JSON.parse(stored) as SummaryFeedbackEntry[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

async function writeAll(entries: SummaryFeedbackEntry[]): Promise<void> {
	const clipped = entries.slice(-MAX_ENTRIES);
	if (hasChromeLocalStorage()) {
		return new Promise((resolve) => {
			try {
				chrome.storage.local.set({ [STORAGE_KEY]: clipped }, () => {
					void chrome.runtime.lastError;
					resolve();
				});
			} catch {
				resolve();
			}
		});
	}
	localStorage.setItem(STORAGE_KEY, JSON.stringify(clipped));
}

export async function addSummaryFeedback(
	entry: Omit<SummaryFeedbackEntry, "timestamp"> & { timestamp?: number },
): Promise<void> {
	const all = await readAll();
	all.push({
		...entry,
		summary: entry.summary.slice(0, 4_000),
		timestamp: entry.timestamp ?? Date.now(),
	});
	await writeAll(all);
}

export async function listSummaryFeedback(): Promise<SummaryFeedbackEntry[]> {
	return readAll();
}

export async function exportSummaryFeedbackJson(): Promise<string> {
	const all = await readAll();
	return JSON.stringify(all, null, 2);
}

/** Parse unit count from Stage 3 debug block if present in full output. */
export function countStage3Units(fullSummaryText: string): number | undefined {
	const match = fullSummaryText.match(
		/## Stage 3[^\n]*\n+([\s\S]*?)(?:\n-----|\n## Summary)/i,
	);
	if (!match) return undefined;
	const lines = match[1]
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => /^\d+\.\s/.test(l));
	return lines.length > 0 ? lines.length : undefined;
}

export function extractVideoIdFromSummary(fullSummaryText: string): string | null {
	const m = fullSummaryText.match(
		/youtube\.com\/watch\?v=([\w-]{6,})|youtu\.be\/([\w-]{6,})/i,
	);
	return m?.[1] ?? m?.[2] ?? null;
}

export function extractSummarySection(fullSummaryText: string): string {
	const idx = fullSummaryText.search(/^## Summary\s*$/im);
	if (idx < 0) return fullSummaryText.trim();
	const after = fullSummaryText.slice(idx).replace(/^## Summary\s*/i, "");
	// Stop at pipeline debug / stage markers if present after summary.
	const cut = after.search(/\n-----|\n## Pipeline debug|\n## Stage \d/i);
	return (cut >= 0 ? after.slice(0, cut) : after).trim();
}
