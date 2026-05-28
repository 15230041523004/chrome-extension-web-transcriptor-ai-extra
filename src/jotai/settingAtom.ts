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
	auto: "onnx-community/whisper-base",
	tiny: "onnx-community/whisper-tiny",
	base: "onnx-community/whisper-base",
	small: "onnx-community/whisper-small",
	medium: "onnx-community/whisper-medium",
};

// List of supported languages:
// https://help.openai.com/en/articles/7031512-whisper-api-faq
// https://github.com/openai/whisper/blob/248b6cb124225dd263bb9bd32d060b6517e067f8/whisper/tokenizer.py#L79
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

export type TranscriptionTask = "transcribe" | "translate";
export type TranscriptionMode = "transcribe" | "translate";
export const TRANSLATE_TARGET_LANGUAGES = ["english"] as const;
export type TranslateTargetLanguage = (typeof TRANSLATE_TARGET_LANGUAGES)[number];

export type TranscriptionSettings = {
	mode: TranscriptionMode;
	transcribeLanguage: TranscriptionLanguage | null;
	translateTargetLanguage: TranslateTargetLanguage | null;
	includeMicrophone: boolean;
	summarizationLanguage: TranscriptionLanguage;
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

function migrateSettings(stored: unknown): TranscriptionSettings {
	if (!stored || typeof stored !== "object") return DEFAULT_SETTINGS;
	const s = stored as Record<string, unknown>;
	if ("language" in s && !("mode" in s)) {
		const lang = s.language as string;
		const base = lang?.includes("/") ? lang.split("/")[0].trim() : lang;
		return {
			mode: base === "english" ? "transcribe" : "translate",
			transcribeLanguage: base === "english" ? (lang as TranscriptionLanguage) : null,
			translateTargetLanguage: "english",
			includeMicrophone: Boolean(s.includeMicrophone),
			summarizationLanguage: (s.language as TranscriptionLanguage) ?? "english",
			whisperModel: "auto",
		};
	}
	return { ...DEFAULT_SETTINGS, ...s } as TranscriptionSettings;
}

const storage = {
	getItem: (key: string, initialValue: TranscriptionSettings): TranscriptionSettings => {
		const stored = localStorage.getItem(key);
		if (!stored) return initialValue;
		try {
			const parsed = JSON.parse(stored) as unknown;
			return migrateSettings(parsed);
		} catch {
			return initialValue;
		}
	},
	setItem: (key: string, value: TranscriptionSettings) => {
		localStorage.setItem(key, JSON.stringify(value));
	},
	removeItem: (key: string) => {
		localStorage.removeItem(key);
	},
};

export const transcriptionSettingsAtom = atomWithStorage<TranscriptionSettings>(
	"transcriptionSettings",
	DEFAULT_SETTINGS,
	storage,
);
