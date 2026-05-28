// ... existing imports ...
import { WHISPER_MODELS, type WhisperModel } from "./jotai/settingAtom";

// ... existing code ...

const SidePanelApp: React.FC = () => {
	const [transcriptionSettings, setTranscriptionSettings] = useAtom(transcriptionSettingsAtom);
	// ... rest of state ...

	// Simple auto model selection (can be improved with actual benchmark later)
	const getRecommendedModel = (): WhisperModel => {
		if (typeof navigator !== "undefined" && navigator.gpu) {
			return "base"; // WebGPU available → base is stable
		}
		return "tiny";
	};

	const handleModelChange = (newModel: WhisperModel) => {
		setTranscriptionSettings(prev => ({ ...prev, whisperModel: newModel }));
		// If Auto, immediately set the recommended one
		if (newModel === "auto") {
			const recommended = getRecommendedModel();
			// We can send message to worker to switch model here if needed
		}
	};

	return (
		<div className="container">
			{/* ... existing Transcription textarea and Model Status ... */}

			<div className="flex flex-col m-1 p-1">
				{/* Transcription Mode + Language (existing) */}

				{/* NEW: Model Selector */}
				<div className="mb-3">
					<span className="text-sm font-medium block mb-1">AI Model</span>
					<select
						value={transcriptionSettings.whisperModel}
						onChange={(e) => handleModelChange(e.target.value as WhisperModel)}
						className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
					>
						{Object.entries(WHISPER_MODELS).map(([key, label]) => (
							<option key={key} value={key}>{label}</option>
						))}
					</select>
					<p className="text-xs text-muted-foreground mt-1">
						Auto picks the best model for your device. Base is recommended for stability.
					</p>
				</div>

				{/* Include microphone + buttons (existing) */}
			</div>
		</div>
	);
};
