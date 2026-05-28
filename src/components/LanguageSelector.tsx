import type React from "react";
import { LANGUAGES, type TranscriptionLanguage } from "@/jotai/settingAtom";

const AUTO_DETECT_VALUE = "__auto__";

const LanguageSelector: React.FC<{
	language: TranscriptionLanguage | null;
	setLanguage: (language: TranscriptionLanguage | null) => void;
	includeAuto?: boolean;
}> = ({ language, setLanguage, includeAuto = false }) => {
	const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const value = e.target.value;
		setLanguage(value === AUTO_DETECT_VALUE ? null : (value as TranscriptionLanguage));
	};

	const currentValue = language ?? AUTO_DETECT_VALUE;

	// Get display names - capitalize first letter for readability
	const getDisplayName = (name: string) => {
		return name.split("/").map(part => 
			part.charAt(0).toUpperCase() + part.slice(1)
		).join("/");
	};

	return (
		<select
			value={currentValue}
			onChange={handleChange}
			className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-violet-500 hover:bg-zinc-800 transition-colors"
		>
			{includeAuto && (
				<option value={AUTO_DETECT_VALUE}>Auto detect from audio</option>
			)}
			{Object.values(LANGUAGES).map((name) => (
				<option key={name} value={name}>
					{getDisplayName(name)}
				</option>
			))}
		</select>
	);
};

export { LanguageSelector };