/**
 * Local summary preferences. No cloud AI keys or online polishing are used.
 */

import { atomWithStorage } from "jotai/utils";
import { createExtensionStorage } from "@/lib/extensionStorage";

export const CLOUD_AI_SETTINGS_KEY = "cloudAiSettings";

export const LOCAL_SUMMARY_MODELS = {
	fast: {
		label: "Fast — RuT5 Base",
		description: "RuT5 abstractive · ~324 MB · then E5/TextRank if rejected",
	},
	balanced: {
		label: "Balanced — E5 extractive",
		description: "Recommended · multilingual E5 + LexRank (faithful; no generative)",
	},
	quality: {
		label: "Quality — E5 extractive",
		description: "Same extractive path as Balanced (Qwen disabled until grounded)",
	},
} as const;

export type LocalSummaryModel = keyof typeof LOCAL_SUMMARY_MODELS;

/** Extractive / length tuning (persisted). */
export type SummaryTuningSettings = {
	/** Target summary body length as fraction of source (0.03–0.25). */
	summaryRatioTarget: number;
	/** Soft floor fraction (0.02–0.15). */
	summaryRatioMin: number;
	/** Ceiling fraction (0.08–0.40). */
	summaryRatioMax: number;
	/** Chrono ranking windows for full-outline (2–16). */
	chronoWindows: number;
	/** Max extractive bullets (4–40). */
	maxBullets: number;
	/** Min bullets when pool allows (1–10). */
	minBullets: number;
	/** Max characters per bullet before clause truncate (280–900). */
	maxBulletChars: number;
};

export type CloudAiSettings = SummaryTuningSettings & {
	/** When false, video output omits Stage 1–3 debug blocks. */
	includePipelineDebug: boolean;
	/** Local model used when Chrome's built-in AI is unavailable. */
	localSummaryModel: LocalSummaryModel;
	/** Prefer browser LanguageModel two-pass when available. */
	allowBrowserAi: boolean;
	/** Prefer grounded polish of extractive notes. */
	allowPolish: boolean;
};

/** Defaults tuned for denser full-outline extractive notes. */
export const DEFAULT_CLOUD_AI_SETTINGS: CloudAiSettings = {
	includePipelineDebug: false,
	localSummaryModel: "quality",
	summaryRatioTarget: 0.25,
	summaryRatioMin: 0.06,
	summaryRatioMax: 0.4,
	chronoWindows: 8,
	maxBullets: 34,
	minBullets: 2,
	maxBulletChars: 360,
	allowBrowserAi: true,
	allowPolish: true,
};

function clamp(n: number, lo: number, hi: number): number {
	if (!Number.isFinite(n)) return lo;
	return Math.min(hi, Math.max(lo, n));
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Clamp and order ratio/bullet fields so min ≤ target ≤ max always holds.
 */
export function normalizeSummarySettings(
	value: Partial<CloudAiSettings> | null | undefined,
): CloudAiSettings {
	const d = DEFAULT_CLOUD_AI_SETTINGS;
	const v = value ?? {};

	let summaryRatioMin = clamp(asNumber(v.summaryRatioMin, d.summaryRatioMin), 0.02, 0.15);
	let summaryRatioTarget = clamp(
		asNumber(v.summaryRatioTarget, d.summaryRatioTarget),
		0.03,
		0.25,
	);
	let summaryRatioMax = clamp(asNumber(v.summaryRatioMax, d.summaryRatioMax), 0.08, 0.4);

	if (summaryRatioMin > summaryRatioTarget) {
		summaryRatioMin = summaryRatioTarget;
	}
	if (summaryRatioTarget > summaryRatioMax) {
		summaryRatioMax = summaryRatioTarget;
	}
	if (summaryRatioMin > summaryRatioMax) {
		summaryRatioMin = summaryRatioMax;
	}

	let minBullets = Math.round(clamp(asNumber(v.minBullets, d.minBullets), 1, 10));
	let maxBullets = Math.round(clamp(asNumber(v.maxBullets, d.maxBullets), 4, 40));
	if (minBullets > maxBullets) {
		minBullets = maxBullets;
	}

	return {
		// Default off: show only final summary unless user enables debug.
		includePipelineDebug:
			typeof v.includePipelineDebug === "boolean"
				? v.includePipelineDebug
				: d.includePipelineDebug,
		localSummaryModel:
			v.localSummaryModel === "fast" ||
			v.localSummaryModel === "balanced" ||
			v.localSummaryModel === "quality"
				? v.localSummaryModel
				: d.localSummaryModel,
		summaryRatioTarget,
		summaryRatioMin,
		summaryRatioMax,
		chronoWindows: Math.round(
			clamp(asNumber(v.chronoWindows, d.chronoWindows), 2, 16),
		),
		maxBullets,
		minBullets,
		maxBulletChars: Math.round(
			clamp(asNumber(v.maxBulletChars, d.maxBulletChars), 280, 900),
		),
		allowBrowserAi:
			typeof v.allowBrowserAi === "boolean" ? v.allowBrowserAi : d.allowBrowserAi,
		allowPolish: typeof v.allowPolish === "boolean" ? v.allowPolish : d.allowPolish,
	};
}

function migrateCloudAiSettings(value: unknown): CloudAiSettings {
	if (!value || typeof value !== "object") {
		return { ...DEFAULT_CLOUD_AI_SETTINGS };
	}
	return normalizeSummarySettings(value as Partial<CloudAiSettings>);
}

const storage = {
	getItem: (key: string, initialValue: CloudAiSettings) =>
		createExtensionStorage<CloudAiSettings>()
			.getItem(key, initialValue)
			.then((value) => migrateCloudAiSettings(value)),
	setItem: (key: string, value: CloudAiSettings) =>
		createExtensionStorage<CloudAiSettings>().setItem(
			key,
			normalizeSummarySettings(value),
		),
	removeItem: (key: string) =>
		createExtensionStorage<CloudAiSettings>().removeItem(key),
};

export const cloudAiSettingsAtom = atomWithStorage<CloudAiSettings>(
	CLOUD_AI_SETTINGS_KEY,
	DEFAULT_CLOUD_AI_SETTINGS,
	storage,
);

export async function loadCloudAiSettings(): Promise<CloudAiSettings> {
	const raw = await createExtensionStorage<CloudAiSettings>().getItem(
		CLOUD_AI_SETTINGS_KEY,
		DEFAULT_CLOUD_AI_SETTINGS,
	);
	return migrateCloudAiSettings(raw);
}

/** Persist normalized defaults (cleanup / reset). */
export async function resetCloudAiSettings(): Promise<CloudAiSettings> {
	const next = { ...DEFAULT_CLOUD_AI_SETTINGS };
	await createExtensionStorage<CloudAiSettings>().setItem(
		CLOUD_AI_SETTINGS_KEY,
		next,
	);
	return next;
}
