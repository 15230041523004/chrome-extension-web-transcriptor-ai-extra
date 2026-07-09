import { LANGUAGES, type TranscriptionLanguage } from "@/jotai/transcriptionSettings";

export type AiSummarizationBackend = "summarizer" | "languageModel" | "legacy" | "none";

export type AiSummarizationStatus = {
	available: boolean;
	backend: AiSummarizationBackend;
	downloading: boolean;
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

async function checkSummarizerAvailability(): Promise<Availability | null> {
	if (typeof Summarizer === "undefined") {
		return null;
	}

	try {
		return await Summarizer.availability({
			type: "key-points",
			format: "markdown",
		});
	} catch {
		return null;
	}
}

async function checkLanguageModelAvailability(): Promise<Availability | null> {
	if (typeof LanguageModel === "undefined") {
		return null;
	}

	try {
		return await LanguageModel.availability(LANGUAGE_MODEL_OPTIONS);
	} catch {
		return null;
	}
}

async function checkLegacyAvailability(): Promise<boolean> {
	if (!window.ai?.languageModel?.capabilities) {
		return false;
	}

	try {
		const { available } = await window.ai.languageModel.capabilities();
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
		};
	}

	const languageModelStatus = await checkLanguageModelAvailability();
	if (languageModelStatus && isAvailabilityUsable(languageModelStatus)) {
		return {
			available: true,
			backend: "languageModel",
			downloading: isDownloading(languageModelStatus),
		};
	}

	if (await checkLegacyAvailability()) {
		return {
			available: true,
			backend: "legacy",
			downloading: false,
		};
	}

	return {
		available: false,
		backend: "none",
		downloading: false,
	};
}

async function createSummarizerBackend(language: TranscriptionLanguage): Promise<SummaryBackend> {
	const bcp47 = toBcp47Language(language);
	const summarizer = await Summarizer.create({
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
	const bcp47 = toBcp47Language(language);
	const session = await LanguageModel.create({
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
	if (!window.ai?.assistant?.create) {
		throw new Error("Legacy Chrome AI is not available.");
	}

	const session = await window.ai.assistant.create({
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

export async function createSummaryBackend(
	systemPrompt: string,
	language: TranscriptionLanguage,
	preferredBackend?: AiSummarizationBackend,
): Promise<SummaryBackend> {
	const status = await getAiSummarizationStatus();
	if (!status.available) {
		throw new Error(
			"AI summarization is not available. Use Chrome/Brave 138+ with on-device AI (Gemini Nano) enabled.",
		);
	}

	const backend = preferredBackend && preferredBackend !== "none" ? preferredBackend : status.backend;

	if (backend === "summarizer" && typeof Summarizer !== "undefined") {
		try {
			return await createSummarizerBackend(language);
		} catch (error) {
			console.warn("[ChromeAI] Summarizer backend failed, falling back:", error);
		}
	}

	if (backend === "languageModel" || backend === "summarizer") {
		if (typeof LanguageModel !== "undefined") {
			try {
				return await createLanguageModelBackend(systemPrompt, language);
			} catch (error) {
				console.warn("[ChromeAI] LanguageModel backend failed, falling back:", error);
			}
		}
	}

	if (window.ai?.assistant?.create) {
		return createLegacyBackend(systemPrompt);
	}

	throw new Error(
		"AI summarization is not available. Use Chrome/Brave 138+ with on-device AI (Gemini Nano) enabled.",
	);
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

export function needsTranslation(backend: AiSummarizationBackend, language: TranscriptionLanguage): boolean {
	return backend !== "summarizer" && language !== "english";
}