export type ModelProgressInfo = {
	status?: string;
	progress?: number;
	loaded?: number;
	total?: number;
};

/** transformers.js reports progress as an object, not a number. */
export function normalizeModelProgress(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.min(100, Math.max(0, Math.round(value <= 1 ? value * 100 : value)));
	}

	if (!value || typeof value !== "object") return 0;

	const info = value as ModelProgressInfo;
	if (typeof info.progress === "number" && Number.isFinite(info.progress)) {
		const p = info.progress;
		return Math.min(100, Math.max(0, Math.round(p <= 1 ? p * 100 : p)));
	}

	if (
		typeof info.loaded === "number" &&
		typeof info.total === "number" &&
		info.total > 0
	) {
		return Math.min(100, Math.max(0, Math.round((info.loaded / info.total) * 100)));
	}

	return 0;
}