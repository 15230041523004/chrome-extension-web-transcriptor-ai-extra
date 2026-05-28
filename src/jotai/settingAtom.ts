import { atomWithStorage } from "jotai/utils";

export const WHISPER_MODELS = {
	auto: "Auto (best for your device)",
	tiny: "Tiny (fastest, lowest quality)",
	base: "Base (recommended - stable)",
	small: "Small (better quality)",
	medium: "Medium (high quality, heavier)",
} as const;

export type WhisperModel = keyof typeof WHISPER_MODELS;

export const MODEL_IDS: Record<WhisperModel, string> = {
	auto: "onnx-community/whisper-base",   // will be overridden by auto logic
	tiny: "onnx-community/whisper-tiny",
	base: "onnx-community/whisper-base",
	small: "onnx-community/whisper-small",
	medium: "onnx-community/whisper-medium",
};

// List of supported languages (unchanged)...
export const LANGUAGES = { /* ... existing LANGUAGES ... */ } as const;

// ... existing types ...

export type TranscriptionSettings = {
	mode: TranscriptionMode;
	transcribeLanguage: TranscriptionLanguage | null;
	translateTargetLanguage: TranslateTargetLanguage | null;
	includeMicrophone: boolean;
	summarizationLanguage: TranscriptionLanguage;
	/** Whisper model selection */
	whisperModel: WhisperModel;
};

const DEFAULT_SETTINGS: TranscriptionSettings = {
	mode: "transcribe",
	transcribeLanguage: null,
	translateTargetLanguage: "english",
	includeMicrophone: false,
	summarizationLanguage: "english" as TranscriptionLanguage,
	whisperModel: "auto",
};

// ... existing migrateSettings and storage (update to include whisperModel) ...

function migrateSettings(stored: unknown): TranscriptionSettings {
	if (!stored || typeof stored !== "object") return DEFAULT_SETTINGS;
	const s = stored as Record<string, unknown>;
	if ("language" in s && !("mode" in s)) {
		// old migration...
	}
	return { ...DEFAULT_SETTINGS, ...s } as TranscriptionSettings;
}

// ... rest of the file unchanged, just add whisperModel to atom ...
export const transcriptionSettingsAtom = atomWithStorage<TranscriptionSettings>(
	"transcriptionSettings",
	DEFAULT_SETTINGS,
	storage,
);
