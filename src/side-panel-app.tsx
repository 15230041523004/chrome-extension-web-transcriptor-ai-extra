import type React from "react";
import { useEffect, useState } from "react";
import { AiSummarizer } from "./components/ai-summarizer";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { useToast } from "./components/ui/use-toast";
import { summarizeWebPage } from "./summarizer";
import { LanguageSelector } from "./components/LanguageSelector";
import {
	type TranscriptionLanguage,
	transcriptionSettingsAtom,
	TRANSLATE_TARGET_LANGUAGES,
	WHISPER_MODELS,
	type WhisperModel,
} from "./jotai/settingAtom";
import { useAtom } from "jotai";
import {
	modelLoadingProgressAtom,
	modelStatusAtom,
} from "./jotai/modelStatusAtom";

const fetchAiCapabilities = async () => {
	if (!window.ai) {
		return { available: "no" };
	}
	const { available } = await window.ai.languageModel.capabilities();
	return { available };
};

const SidePanelApp: React.FC = () => {
	const [summary, setSummary] = useState("");
	const [transcriptionSettings, setTranscriptionSettings] = useAtom(transcriptionSettingsAtom);
	const [isSummaryLoading, setIsSummaryLoading] = useState(false);
	const [aiCapabilities, setAiCapabilities] = useState<{ available: string }>({ available: "no" });
	const [transcription, setTranscription] = useState("");
	const [modelStatus, setModelStatus] = useAtom(modelStatusAtom);
	const [loadingProgress, setLoadingProgress] = useAtom(modelLoadingProgressAtom);
	const [isRecording, setIsRecording] = useState(false);

	useEffect(() => {
		fetchAiCapabilities().then((capabilities) => {
			setAiCapabilities(capabilities);
		});

		chrome.runtime.sendMessage(
			{ type: "get-recording-state" },
			(response?: { recording?: boolean }) => {
				if (response?.recording !== undefined) {
					setIsRecording(response.recording);
				}
			},
		);

		const messageListener = (message: {
			type?: string;
			data?: {
				transcripted?: string;
				status?: string;
				progress?: number;
				recording?: boolean;
			};
		}) => {
			if (message.type === "transcript") {
				setTranscription((prev) => `${prev}\n${message.data?.transcripted ?? ""}`);
			} else if (message.type === "model-status") {
				const status = message.data?.status;
				setModelStatus(
					status === "loading" || status === "ready" || status === "error"
						? status
						: "unknown",
				);
				if (message.data?.status === "loading") {
					setLoadingProgress(message.data?.progress ?? 0);
				}
			} else if (message.type === "recording-state") {
				setIsRecording(message.data?.recording ?? false);
			}
		};
		chrome.runtime.onMessage.addListener(messageListener);
		return () => {
			chrome.runtime.onMessage.removeListener(messageListener);
		};
	}, [setModelStatus, setLoadingProgress]);

	const { toast } = useToast();

	const handleSummarize = async () => {
		setIsSummaryLoading(true);
		try {
			const result = await summarizeWebPage(transcriptionSettings.summarizationLanguage);
			setSummary(result);
			toast({ description: "Summarized", color: "success" });
		} catch (error) {
			console.error(error);
			setSummary(`Failed to summarize: ${error}`);
			toast({ description: "Failed to summarize", color: "error" });
		} finally {
			setIsSummaryLoading(false);
		}
	};

	// Simple auto model selection
	const getRecommendedModel = (): WhisperModel => {
		if (typeof navigator !== "undefined" && (navigator as any).gpu) {
			return "base";
		}
		return "tiny";
	};

	const handleModelChange = (newModel: WhisperModel) => {
		setTranscriptionSettings((prev) => ({
			...prev,
			whisperModel: newModel,
		}));
	};

	return (
		<div className="container">
			<div className="box-border">
				<div className="flex flex-col m-1 p-1">
					<h1>Transcription</h1>
					<div className="text-center mt-1">
						<Textarea value={transcription} rows={20} readOnly />
					</div>
					<div className="text-center">
						<h1>Model Status: {modelStatus}</h1>
						{modelStatus === "loading" && <p>{loadingProgress}% loaded</p>}
					</div>
				</div>

				<div className="flex flex-col m-1 p-1">
					{/* Transcription Mode */}
					<div className="mb-2">
						<span className="text-sm font-medium block mb-1">Transcription Mode</span>
						<div className="flex gap-4">
							<label className="flex items-center gap-2 cursor-pointer">
								<input
									type="radio"
									name="mode"
									checked={transcriptionSettings.mode === "transcribe"}
									onChange={() => setTranscriptionSettings((prev) => ({ ...prev, mode: "transcribe" }))}
								/>
								<span className="text-sm">Transcribe</span>
							</label>
							<label className="flex items-center gap-2 cursor-pointer">
								<input
									type="radio"
									name="mode"
									checked={transcriptionSettings.mode === "translate"}
									onChange={() => setTranscriptionSettings((prev) => ({ ...prev, mode: "translate" }))}
								/>
								<span className="text-sm">Translate</span>
							</label>
						</div>
					</div>

					{/* Source Language */}
					{transcriptionSettings.mode === "transcribe" && (
						<div className="mb-2">
							<span className="text-sm font-medium block mb-1">Source Language</span>
							<LanguageSelector
								language={transcriptionSettings.transcribeLanguage}
								setLanguage={(lang) => setTranscriptionSettings((prev) => ({ ...prev, transcribeLanguage: lang }))}
								includeAuto
							/>
							<p className="text-xs text-muted-foreground mt-1">Output in the same language as input</p>
						</div>
					)}

					{/* NEW: AI Model Selector */}
					<div className="mb-3">
						<span className="text-sm font-medium block mb-1">AI Model</span>
						<select
							value={transcriptionSettings.whisperModel}
							onChange={(e) => handleModelChange(e.target.value as WhisperModel)}
							className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-violet-500 hover:bg-zinc-800 transition-colors"
						>
							{Object.entries(WHISPER_MODELS).map(([key, label]) => (
								<option key={key} value={key}>{label}</option>
							))}
						</select>
						<p className="text-xs text-muted-foreground mt-1">
							Auto picks the best model for your device. Base is recommended for stability.
						</p>
					</div>

					<label className="flex items-center gap-2 mt-2 cursor-pointer">
						<input
							type="checkbox"
							checked={transcriptionSettings.includeMicrophone ?? false}
							onChange={(e) => setTranscriptionSettings((prev) => ({ ...prev, includeMicrophone: e.target.checked }))}
							className="rounded"
						/>
						<span className="text-sm">Include microphone</span>
					</label>
					<p className="text-xs text-muted-foreground mt-0.5">Mix your voice with tab audio for transcription</p>
				</div>

				{/* Resume / Stop buttons */}
				<div className="flex flex-col gap-2 m-1 p-1">
					<div className="flex gap-2">
						<Button
							variant={isRecording ? "outline" : "default"}
							disabled={isRecording}
							onClick={() => chrome.runtime.sendMessage({ type: "start-transcription" })}
						>
							Resume
						</Button>
						<Button
							variant={isRecording ? "destructive" : "outline"}
							disabled={!isRecording}
							onClick={() => chrome.runtime.sendMessage({ type: "stop-transcription" })}
						>
							Stop
						</Button>
					</div>
				</div>

				{/* Copy button */}
				<div className="flex flex-col m-1 p-1">
					<Button
						onClick={() => {
							navigator.clipboard.writeText(transcription);
							toast({ description: "Copied to clipboard", color: "success", duration: 1000 });
						}}
					>
						Copy to Clipboard
					</Button>
				</div>

				{aiCapabilities.available === "no" && (
					<div className="flex flex-col m-1 p-1">
						<div className="text-center">
							<h1>AI Summarization is not available</h1>
							<p>Please make sure your Chrome supports Prompt API.</p>
						</div>
					</div>
				)}
				{aiCapabilities.available !== "no" && (
					<AiSummarizer
						setLanguage={(language: TranscriptionLanguage) =>
							setTranscriptionSettings((prev) => ({ ...prev, summarizationLanguage: language }))}
						language={transcriptionSettings.summarizationLanguage}
						isSummaryLoading={isSummaryLoading}
						handleSummarize={handleSummarize}
						summary={summary}
					/>
				)}
			</div>
		</div>
	);
};

export default SidePanelApp;
