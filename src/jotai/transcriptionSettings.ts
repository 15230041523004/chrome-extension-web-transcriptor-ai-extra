import { createExtensionStorage } from "@/lib/extensionStorage";

export const WHISPER_MODELS = {
	auto: "Auto (best for your device)",
	tiny: "Tiny (fastest, lowest quality)",
	base: "Base (recommended - stable)",
	small: "Small (better quality)",
	medium: "Medium (high quality, heavier)",
} as const;

export type WhisperModel = keyof typeof WHISPER_MODELS;

export const MODEL_IDS: Record<WhisperModel, string> = {
	auto: "onnx-community/whisper-base",
	tiny: "onnx-community/whisper-tiny",
	base: "onnx-community/whisper-base",
	small: "onnx-community/whisper-small",
	medium: "onnx-community/whisper-medium",
};

export function getWhisperModelLabelFromId(
	modelId: string | null | undefined,
): string | undefined {
	if (!modelId) return undefined;
	const match = (Object.entries(MODEL_IDS) as [WhisperModel, string][]).find(
		([key, id]) => key !== "auto" && id === modelId,
	);
	return match ? WHISPER_MODELS[match[0]] : modelId;
}

export function getWhisperModelTooltipLabel(
	loadedModelId: string | null | undefined,
	whisperModel: WhisperModel,
): string {
	const loadedLabel = getWhisperModelLabelFromId(loadedModelId);
	if (loadedLabel) return loadedLabel;
	return WHISPER_MODELS[whisperModel];
}

export const LANGUAGES = {
	en: "english",
	zh: "chinese",
	de: "german",
	es: "spanish/castilian",
	ru: "russian",
	ko: "korean",
	fr: "french",
	ja: "japanese",
	pt: "portuguese",
	tr: "turkish",
	pl: "polish",
	ca: "catalan/valencian",
	nl: "dutch/flemish",
	ar: "arabic",
	sv: "swedish",
	it: "italian",
	id: "indonesian",
	hi: "hindi",
	fi: "finnish",
	vi: "vietnamese",
	he: "hebrew",
	uk: "ukrainian",
	el: "greek",
	ms: "malay",
	cs: "czech",
	ro: "romanian/moldavian/moldovan",
	da: "danish",
	hu: "hungarian",
	ta: "tamil",
	no: "norwegian",
	th: "thai",
	ur: "urdu",
	hr: "croatian",
	bg: "bulgarian",
	lt: "lithuanian",
	la: "latin",
	mi: "maori",
	ml: "malayalam",
	cy: "welsh",
	sk: "slovak",
	te: "telugu",
	fa: "persian",
	lv: "latvian",
	bn: "bengali",
	sr: "serbian",
	az: "azerbaijani",
	sl: "slovenian",
	kn: "kannada",
	et: "estonian",
	mk: "macedonian",
	br: "breton",
	eu: "basque",
	is: "icelandic",
	hy: "armenian",
	ne: "nepali",
	mn: "mongolian",
	bs: "bosnian",
	kk: "kazakh",
	sq: "albanian",
	sw: "swahili",
	gl: "galician",
	mr: "marathi",
	pa: "punjabi/panjabi",
	si: "sinhala/sinhalese",
	km: "khmer",
	sn: "shona",
	yo: "yoruba",
	so: "somali",
	af: "afrikaans",
	oc: "occitan",
	ka: "georgian",
	be: "belarusian",
	tg: "tajik",
	sd: "sindhi",
	gu: "gujarati",
	am: "amharic",
	yi: "yiddish",
	lo: "lao",
	uz: "uzbek",
	fo: "faroese",
	ht: "haitian creole/haitian",
	ps: "pashto/pushto",
	tk: "turkmen",
	nn: "nynorsk",
	mt: "maltese",
	sa: "sanskrit",
	lb: "luxembourgish/letzeburgesch",
	my: "myanmar/burmese",
	bo: "tibetan",
	tl: "tagalog",
	mg: "malagasy",
	as: "assamese",
	tt: "tatar",
	haw: "hawaiian",
	ln: "lingala",
	ha: "hausa",
	ba: "bashkir",
	jw: "javanese",
	su: "sundanese",
} as const;

export type TranscriptionLanguage = (typeof LANGUAGES)[keyof typeof LANGUAGES];

/** Locale hint for auto-detect only (not shown in the language dropdown). */
export function getLanguageDetectionPriority(): string | null {
	if (typeof navigator === "undefined") return "ru";

	const localeCode = navigator.language.split("-")[0]?.toLowerCase();
	if (localeCode === "ru" || localeCode === "uk" || localeCode === "be" || localeCode === "kk") {
		return "ru";
	}

	return null;
}
export type TranscriptionTask = "transcribe" | "translate";
export type TranscriptionMode = "transcribe" | "translate";
export const TRANSLATE_TARGET_LANGUAGES = ["english"] as const;
export type TranslateTargetLanguage = (typeof TRANSLATE_TARGET_LANGUAGES)[number];

export type TranscriptionSettings = {
	mode: TranscriptionMode;
	transcribeLanguage: TranscriptionLanguage | null;
	translateTargetLanguage: TranslateTargetLanguage | null;
	includeMicrophone: boolean;
	autoscroll: boolean;
	speakerDetection: boolean;
	summarizationLanguage: TranscriptionLanguage;
	whisperModel: WhisperModel;
};

export const TRANSCRIPTION_SETTINGS_KEY = "transcriptionSettings";

const SETTINGS_STORAGE_VERSION = 5;

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
	mode: "transcribe",
	transcribeLanguage: null,
	translateTargetLanguage: "english",
	includeMicrophone: false,
	autoscroll: true,
	speakerDetection: false,
	summarizationLanguage: "english" as TranscriptionLanguage,
	whisperModel: "auto",
};

function resolveTranscribeLanguage(
	stored: Record<string, unknown>,
	storageVersion: number,
): TranscriptionLanguage | null {
	if (storageVersion < SETTINGS_STORAGE_VERSION) {
		return null;
	}

	if (stored.transcribeLanguage === null) {
		return null;
	}

	if (typeof stored.transcribeLanguage === "string") {
		return stored.transcribeLanguage as TranscriptionLanguage;
	}

	return null;
}

function resolveStoredSettings(stored: Record<string, unknown>): Pick<
	TranscriptionSettings,
	"speakerDetection" | "mode" | "transcribeLanguage"
> {
	const storageVersion =
		typeof stored.settingsVersion === "number" ? stored.settingsVersion : 1;

	if (storageVersion < SETTINGS_STORAGE_VERSION) {
		return {
			speakerDetection: false,
			mode: "transcribe",
			transcribeLanguage: resolveTranscribeLanguage(stored, storageVersion),
		};
	}

	return {
		speakerDetection: stored.speakerDetection === true,
		mode: stored.mode === "translate" ? "translate" : "transcribe",
		transcribeLanguage: resolveTranscribeLanguage(stored, storageVersion),
	};
}

export function migrateTranscriptionSettings(stored: unknown): TranscriptionSettings {
	if (!stored || typeof stored !== "object") return DEFAULT_TRANSCRIPTION_SETTINGS;
	const s = stored as Record<string, unknown>;
	if ("language" in s && !("mode" in s)) {
		return {
			...DEFAULT_TRANSCRIPTION_SETTINGS,
			mode: "transcribe",
			transcribeLanguage: null,
			translateTargetLanguage: "english",
			includeMicrophone: Boolean(s.includeMicrophone),
			summarizationLanguage: (s.language as TranscriptionLanguage) ?? "english",
			speakerDetection: false,
		};
	}

	const { settingsVersion: _version, ...rest } = s;
	const resolved = resolveStoredSettings(s);

	return {
		...DEFAULT_TRANSCRIPTION_SETTINGS,
		...rest,
		mode: resolved.mode,
		speakerDetection: resolved.speakerDetection,
		transcribeLanguage: resolved.transcribeLanguage,
	} as TranscriptionSettings;
}

export function persistTranscriptionSettings(
	settings: TranscriptionSettings,
): TranscriptionSettings & { settingsVersion: number } {
	return { ...settings, settingsVersion: SETTINGS_STORAGE_VERSION };
}

export async function loadTranscriptionSettings(): Promise<TranscriptionSettings> {
	const raw = await createExtensionStorage<TranscriptionSettings>().getItem(
		TRANSCRIPTION_SETTINGS_KEY,
		DEFAULT_TRANSCRIPTION_SETTINGS,
	);
	return migrateTranscriptionSettings(raw);
}