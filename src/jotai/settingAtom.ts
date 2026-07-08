import { atomWithStorage } from "jotai/utils";
import { createExtensionStorage } from "@/lib/extensionStorage";
import {
	DEFAULT_TRANSCRIPTION_SETTINGS,
	migrateTranscriptionSettings,
	persistTranscriptionSettings,
	TRANSCRIPTION_SETTINGS_KEY,
	type TranscriptionSettings,
} from "./transcriptionSettings";

export * from "./transcriptionSettings";

const storage = {
	getItem: (key: string, initialValue: TranscriptionSettings) =>
		createExtensionStorage<TranscriptionSettings>()
			.getItem(key, initialValue)
			.then((value) => migrateTranscriptionSettings(value)),
	setItem: (key: string, value: TranscriptionSettings) =>
		createExtensionStorage<TranscriptionSettings>().setItem(
			key,
			persistTranscriptionSettings(value),
		),
	removeItem: (key: string) =>
		createExtensionStorage<TranscriptionSettings>().removeItem(key),
};

export const transcriptionSettingsAtom = atomWithStorage<TranscriptionSettings>(
	TRANSCRIPTION_SETTINGS_KEY,
	DEFAULT_TRANSCRIPTION_SETTINGS,
	storage,
);