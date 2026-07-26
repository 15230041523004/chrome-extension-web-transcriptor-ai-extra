import { LANGUAGES, type TranscriptionLanguage } from "@/jotai/transcriptionSettings";
import { getLocalSummarizerState, summarizeLocally } from "@/lib/localSummarizer";
import { loadCloudAiSettings } from "@/lib/cloudAiSettings";

export type AiSummarizationBackend =
	| "summarizer"
	| "languageModel"
	| "legacy"
	| "local"
	| "none";

export type AiSummarizationStatus = {
	available: boolean;
	backend: AiSummarizationBackend;
	downloading: boolean;
	reason: "ready" | "downloading" | "api-missing" | "model-unavailable";
	browserAiAvailable: boolean;
};

export type SummaryBackend = {
	backend: AiSummarizationBackend;
	summarize(prompt: string): Promise<string>;
	destroy(): void;
};

type Availability = "unavailable" | "downloadable" | "downloading" | "available";

const LANGUAGE_MODEL_OPTIONS = {
	expectedInputs: [{ type: "text" as const, languages: ["en"] }],
	expectedOutputs: [{ type: "text" as const, languages: ["en"] }],
};

function isAvailabilityUsable(status: Availability): boolean {
	return status !== "unavailable";
}

function isDownloading(status: Availability): boolean {
	return status === "downloadable" || status === "downloading";
}

export function toBcp47Language(language: TranscriptionLanguage): string {
	const match = (Object.entries(LANGUAGES) as [string, TranscriptionLanguage][]).find(
		([, name]) => name === language,
	);
	return match?.[0] ?? "en";
}

function getLanguageDisplayName(language: TranscriptionLanguage): string {
	return language
		.split("/")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("/");
}

function getSummarizerApi(): typeof Summarizer | undefined {
	return (globalThis as typeof globalThis & { Summarizer?: typeof Summarizer }).Summarizer;
}

function getLanguageModelApi(): typeof LanguageModel | undefined {
	return (globalThis as typeof globalThis & { LanguageModel?: typeof LanguageModel }).LanguageModel;
}

function getLegacyAi(): typeof window.ai | undefined {
	return (globalThis as typeof globalThis & { ai?: typeof window.ai }).ai;
}

async function checkSummarizerAvailability(): Promise<Availability | null> {
	const summarizerApi = getSummarizerApi();
	if (!summarizerApi) {
		return null;
	}

	try {
		return await summarizerApi.availability();
	} catch {
		try {
			return await summarizerApi.availability({
				type: "key-points",
				format: "markdown",
			});
		} catch {
			return null;
		}
	}
}

async function checkLanguageModelAvailability(): Promise<Availability | null> {
	const languageModelApi = getLanguageModelApi();
	if (!languageModelApi) {
		return null;
	}

	try {
		return await languageModelApi.availability();
	} catch {
		try {
			return await languageModelApi.availability(LANGUAGE_MODEL_OPTIONS);
		} catch {
			return null;
		}
	}
}

async function checkLegacyAvailability(): Promise<boolean> {
	const legacyAi = getLegacyAi();
	if (!legacyAi?.assistant?.create) {
		return false;
	}
	if (!legacyAi.languageModel?.capabilities) return true;

	try {
		const { available } = await legacyAi.languageModel.capabilities();
		return available !== "no" && available !== "unavailable";
	} catch {
		return false;
	}
}

export async function getAiSummarizationStatus(): Promise<AiSummarizationStatus> {
	const summarizerStatus = await checkSummarizerAvailability();
	if (summarizerStatus && isAvailabilityUsable(summarizerStatus)) {
		return {
			available: true,
			backend: "summarizer",
			downloading: isDownloading(summarizerStatus),
			reason: isDownloading(summarizerStatus) ? "downloading" : "ready",
			browserAiAvailable: true,
		};
	}

	const languageModelStatus = await checkLanguageModelAvailability();
	if (languageModelStatus && isAvailabilityUsable(languageModelStatus)) {
		return {
			available: true,
			backend: "languageModel",
			downloading: isDownloading(languageModelStatus),
			reason: isDownloading(languageModelStatus) ? "downloading" : "ready",
			browserAiAvailable: true,
		};
	}

	if (await checkLegacyAvailability()) {
		return {
			available: true,
			backend: "legacy",
			downloading: false,
			reason: "ready",
			browserAiAvailable: true,
		};
	}

	const localState = getLocalSummarizerState();
	return {
		available: true,
		backend: "local",
		downloading:
			localState.status === "loading" || localState.status === "summarizing",
		reason:
			summarizerStatus === null && languageModelStatus === null
				? "api-missing"
				: "model-unavailable",
		browserAiAvailable: false,
	};
}

async function createSummarizerBackend(language: TranscriptionLanguage): Promise<SummaryBackend> {
	const summarizerApi = getSummarizerApi();
	if (!summarizerApi) {
		throw new Error("Browser Summarizer API is not available.");
	}

	const bcp47 = toBcp47Language(language);
	const summarizer = await summarizerApi.create({
		type: "key-points",
		format: "markdown",
		outputLanguage: bcp47,
	});

	return {
		backend: "summarizer",
		summarize: (input) => summarizer.summarize(input),
		destroy: () => {
			summarizer.destroy();
		},
	};
}

async function createLanguageModelBackend(
	systemPrompt: string,
	language: TranscriptionLanguage,
): Promise<SummaryBackend> {
	const languageModelApi = getLanguageModelApi();
	if (!languageModelApi) {
		throw new Error("Browser Language Model API is not available.");
	}

	const bcp47 = toBcp47Language(language);
	const session = await languageModelApi.create({
		...LANGUAGE_MODEL_OPTIONS,
		expectedInputs: [{ type: "text", languages: ["en", bcp47] }],
		expectedOutputs: [{ type: "text", languages: [bcp47] }],
		initialPrompts: [{ role: "system", content: systemPrompt }],
	});

	return {
		backend: "languageModel",
		summarize: (prompt) => session.prompt(prompt),
		destroy: () => {
			session.destroy();
		},
	};
}

async function createLegacyBackend(systemPrompt: string): Promise<SummaryBackend> {
	const legacyAi = getLegacyAi();
	if (!legacyAi?.assistant?.create) {
		throw new Error("Legacy Chrome AI is not available.");
	}

	const session = await legacyAi.assistant.create({
		systemPrompt,
		topK: 10,
		temperature: 0,
	});

	return {
		backend: "legacy",
		summarize: (prompt) => session.prompt(prompt),
		destroy: () => {
			session.destroy();
		},
	};
}

function createLocalBackend(language: TranscriptionLanguage): SummaryBackend {
	return {
		backend: "local",
		summarize: async (prompt) => {
			const settings = await loadCloudAiSettings();
			return summarizeLocally(prompt, language, {
				localSummaryModel: settings.localSummaryModel,
				summaryRatioTarget: settings.summaryRatioTarget,
				summaryRatioMin: settings.summaryRatioMin,
				summaryRatioMax: settings.summaryRatioMax,
				chronoWindows: settings.chronoWindows,
				maxBullets: settings.maxBullets,
				minBullets: settings.minBullets,
				maxBulletChars: settings.maxBulletChars,
			});
		},
		destroy: () => undefined,
	};
}

export async function createSummaryBackend(
	systemPrompt: string,
	language: TranscriptionLanguage,
	preferredBackend?: AiSummarizationBackend,
): Promise<SummaryBackend> {
	const status = await getAiSummarizationStatus();
	const backend = preferredBackend && preferredBackend !== "none" ? preferredBackend : status.backend;

	if (backend === "summarizer" && getSummarizerApi()) {
		try {
			return await createSummarizerBackend(language);
		} catch (error) {
			console.warn("[ChromeAI] Summarizer backend failed, falling back:", error);
		}
	}

	if (backend === "languageModel" || backend === "summarizer") {
		if (getLanguageModelApi()) {
			try {
				return await createLanguageModelBackend(systemPrompt, language);
			} catch (error) {
				console.warn("[ChromeAI] LanguageModel backend failed, falling back:", error);
			}
		}
	}

	if (getLegacyAi()?.assistant?.create) {
		return createLegacyBackend(systemPrompt);
	}

	return createLocalBackend(language);
}

export async function translateSummaryText(
	summary: string,
	targetLanguage: TranscriptionLanguage,
): Promise<string> {
	if (targetLanguage === "english") {
		return summary;
	}

	const session = await createSummaryBackend(
		"You are a helpful assistant that translates summaries while preserving markdown formatting.",
		targetLanguage,
		"languageModel",
	);

	try {
		const languageName = getLanguageDisplayName(targetLanguage);
		return await session.summarize(
			`Translate the following summary to ${languageName}. Keep markdown formatting:\n\n${summary}`,
		);
	} finally {
		session.destroy();
	}
}

export function needsTranslation(
	backend: AiSummarizationBackend,
	language: TranscriptionLanguage,
): boolean {
	return backend !== "summarizer" && backend !== "local" && language !== "english";
}
