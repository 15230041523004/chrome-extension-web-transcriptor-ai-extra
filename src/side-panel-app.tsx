import type React from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import { AiSummarizer } from "./components/ai-summarizer";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { useToast } from "./components/ui/use-toast";
import { summarizeWebPage } from "./summarizer";
import { LanguageSelector } from "./components/LanguageSelector";
import {
	type TranscriptionLanguage,
	transcriptionSettingsAtom,
	TRANSLATE_TARGET_LANGUAGES as _TRANSLATE_TARGET_LANGUAGES,
	WHISPER_MODELS,
	type WhisperModel,
	getWhisperModelTooltipLabel,
} from "./jotai/settingAtom";
import { useAtom } from "jotai";
import {
	loadedModelIdAtom,
	modelLoadingProgressAtom,
	modelStatusAtom,
} from "./jotai/modelStatusAtom";
import { normalizeModelProgress } from "./lib/modelProgress";

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
	const [loadedModelId, setLoadedModelId] = useAtom(loadedModelIdAtom);
	const [isRecording, setIsRecording] = useState(false);
	const [activeTabId, setActiveTabId] = useState<number | null>(null);
	const [activeTabUrl, setActiveTabUrl] = useState<string | undefined>(undefined);
	const [captureError, setCaptureError] = useState<string | null>(null);
	const [modelError, setModelError] = useState<string | null>(null);
	const [showMoreSettings, setShowMoreSettings] = useState(false);
	const transcriptionRef = useRef<HTMLTextAreaElement>(null);

	const isCapturableUrl = (url: string | undefined): boolean => {
		if (!url) return false;
		const blockedPrefixes = [
			"chrome://",
			"chrome-extension://",
			"about:",
			"edge://",
			"brave://",
			"devtools://",
		];
		return !blockedPrefixes.some((prefix) => url.startsWith(prefix));
	};

	const refreshActiveTab = () => {
		chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
			const tab = tabs[0];
			if (typeof tab?.id === "number") {
				setActiveTabId(tab.id);
				setActiveTabUrl(tab.url);
			}
		});
	};

	const handleStartTranscription = () => {
		if (isRecording) {
			chrome.runtime.sendMessage({ type: "stop-transcription" });
			return;
		}

		if (activeTabId === null) {
			setCaptureError("Не удалось определить активную вкладку. Переключитесь на вкладку с аудио и попробуйте снова.");
			return;
		}

		if (!isCapturableUrl(activeTabUrl)) {
			setCaptureError(
				`Нельзя захватить эту страницу (${activeTabUrl ?? "unknown"}). Откройте YouTube и кликните иконку расширения на вкладке с видео.`,
			);
			return;
		}

		chrome.runtime.sendMessage({ type: "prepare-capture", target: "offscreen" });
		chrome.tabCapture.getMediaStreamId({ targetTabId: activeTabId }, (streamId) => {
			const captureError = chrome.runtime.lastError;
			if (captureError || !streamId) {
				const detail = captureError?.message ?? "unknown error";
				if (detail.includes("not been invoked") || detail.includes("activeTab")) {
					setCaptureError(
						"Chrome разрешает захват только при клике по иконке расширения на вкладке с видео. Закройте side panel, откройте YouTube и кликните иконку.",
					);
				} else {
					setCaptureError(`Захват отклонён: ${detail}`);
				}
				return;
			}

			chrome.runtime.sendMessage({ type: "start-with-stream-id", streamId });
		});
	};

	useEffect(() => {
		fetchAiCapabilities().then((capabilities) => {
			setAiCapabilities(capabilities);
		});

		refreshActiveTab();
		const onTabActivated = () => refreshActiveTab();
		const onTabUpdated = (_tabId: number, changeInfo: { url?: string; status?: string }) => {
			if (changeInfo.url || changeInfo.status === "complete") {
				refreshActiveTab();
			}
		};
		chrome.tabs.onActivated.addListener(onTabActivated);
		chrome.tabs.onUpdated.addListener(onTabUpdated);

		chrome.runtime.sendMessage(
			{ type: "get-recording-state" },
			(response?: { recording?: boolean }) => {
				if (response?.recording !== undefined) {
					setIsRecording(response.recording);
				}
			},
		);

		const messageListener = (message: any) => {
			if (message.type === "transcript") {
				const next = (message.data?.transcripted ?? "").trim();
				if (!next) return;
				setTranscription((prev) => (prev ? `${prev}\n${next}` : next));
			} else if (message.type === "transcript-diarized") {
				const next = (message.data?.transcripted ?? "").trim();
				if (!next) return;
				setTranscription(next);
			} else if (message.type === "model-status") {
				const status = message.data?.status;
				setModelStatus(
					status === "loading" ||
						status === "ready" ||
						status === "error" ||
						status === "diarizing"
						? status
						: "unknown",
				);
				if (status === "error") {
					setModelError(typeof message.data?.message === "string" ? message.data.message : "Ошибка модели (см. консоль)");
					setTimeout(() => setModelError(null), 8000);
				}
				if (status === "loading" || status === "diarizing") {
					setLoadingProgress(normalizeModelProgress(message.data?.progress));
				}
				if (typeof message.data?.modelId === "string") {
					setLoadedModelId(message.data.modelId);
				}
			} else if (message.type === "recording-state") {
				setIsRecording(message.data?.recording ?? false);
			} else if (message.type === "capture-error") {
				setCaptureError(typeof message.data?.error === "string" ? message.data.error : String(message.data?.error || "Неизвестная ошибка"));
				setTimeout(() => setCaptureError(null), 8000);
			}
		};
		chrome.runtime.onMessage.addListener(messageListener);
		return () => {
			chrome.runtime.onMessage.removeListener(messageListener);
			chrome.tabs.onActivated.removeListener(onTabActivated);
			chrome.tabs.onUpdated.removeListener(onTabUpdated);
		};
	}, [setModelStatus, setLoadingProgress, setLoadedModelId]);

	useEffect(() => {
		if (!transcriptionSettings.autoscroll) return;
		const textarea = transcriptionRef.current;
		if (textarea) {
			textarea.scrollTop = textarea.scrollHeight;
		}
	}, [transcription, transcriptionSettings.autoscroll]);

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

	const getRecommendedModel = (): WhisperModel => {
		if (typeof navigator !== "undefined" && (navigator as any).gpu) {
			return "base";
		}
		return "tiny";
	};

	const isModelBusy = modelStatus === "loading" || modelStatus === "diarizing";

	const modelStatusLabel =
		modelStatus === "diarizing" ? "Processing speakers..." : modelStatus;

	const modelStatusTooltip = getWhisperModelTooltipLabel(
		loadedModelId,
		transcriptionSettings.whisperModel,
	);

	const handleModelChange = (newModel: WhisperModel) => {
		let finalModel = newModel;
		if (newModel === "auto") {
			finalModel = getRecommendedModel();
		}
		setTranscriptionSettings((prev) => ({
			...prev,
			whisperModel: finalModel,
		}));
	};

	return (
		<div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
			<section className="flex min-h-0 flex-1 flex-col px-2 pt-2 pb-1">
				<div className="flex shrink-0 items-center gap-3">
					<h1 className="shrink-0 text-base font-semibold">Transcription</h1>
					<p
						className="min-w-0 flex-1 truncate text-center text-xs text-muted-foreground"
						title={modelStatusTooltip}
					>
						<span className="font-medium text-foreground">Model Status: </span>
						{modelStatusLabel}
						{modelStatus === "loading" && ` (${loadingProgress}% loaded)`}
						{modelStatus === "diarizing" && loadingProgress > 0 && ` (${loadingProgress}%)`}
					</p>
					<label className="flex shrink-0 cursor-pointer items-center gap-2">
						<input
							type="checkbox"
							checked={transcriptionSettings.autoscroll}
							onChange={(e) =>
								setTranscriptionSettings((prev) => ({ ...prev, autoscroll: e.target.checked }))
							}
							className="rounded"
						/>
						<span className="text-sm">Autoscroll</span>
					</label>
				</div>
				<Textarea
					ref={transcriptionRef}
					value={transcription}
					readOnly
					className="mt-1 min-h-0 flex-1 resize-none"
				/>
			</section>

			{captureError && (
				<div className="mx-2 mb-1 shrink-0 rounded border border-red-700 bg-red-900/30 p-2 text-xs text-red-200">
					{captureError}
				</div>
			)}
			{modelError && (
				<div className="mx-2 mb-1 shrink-0 rounded border border-orange-700 bg-orange-900/30 p-2 text-xs text-orange-200">
					{modelError}
				</div>
			)}

			<div className="shrink-0 border-t border-border px-2 py-2">
				<Button
					type="button"
					variant="outline"
					onClick={() => setShowMoreSettings((open) => !open)}
					aria-expanded={showMoreSettings}
					className="h-auto w-full justify-between gap-3 px-3 py-2.5 text-left"
				>
					<span className="flex min-w-0 items-center gap-2.5">
						<SlidersHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span className="flex min-w-0 flex-col">
							<span className="text-sm font-semibold text-foreground">
								{showMoreSettings ? "Less" : "More..."}
							</span>
							<span className="truncate text-xs font-normal text-muted-foreground">
								{showMoreSettings ? "Hide language, model & options" : "Language, model & options"}
							</span>
						</span>
					</span>
					{showMoreSettings ? (
						<ChevronUp className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
					) : (
						<ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
					)}
				</Button>
			</div>

			{showMoreSettings && (
				<div className="max-h-[45vh] shrink-0 overflow-y-auto border-t border-border px-2 py-2">
					<div className="mb-2">
						<span className="mb-1 block text-sm font-medium">Transcription Mode</span>
						<div className="flex gap-4">
							<label className="flex cursor-pointer items-center gap-2">
								<input
									type="radio"
									name="mode"
									checked={(transcriptionSettings.mode ?? "transcribe") === "transcribe"}
									onChange={() => setTranscriptionSettings((prev) => ({ ...prev, mode: "transcribe" }))}
								/>
								<span className="text-sm">Transcribe</span>
							</label>
							<label className="flex cursor-pointer items-center gap-2">
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

					{transcriptionSettings.mode === "transcribe" && (
						<div className="mb-2">
							<span className="mb-1 block text-sm font-medium">Source Language</span>
							<LanguageSelector
								language={transcriptionSettings.transcribeLanguage}
								setLanguage={(lang) => setTranscriptionSettings((prev) => ({ ...prev, transcribeLanguage: lang }))}
								includeAuto
							/>
							<p className="mt-1 text-xs text-muted-foreground">
								{transcriptionSettings.transcribeLanguage === null
									? "Auto-detects language from audio (Russian preferred when ambiguous)"
									: "Output in the same language as input"}
							</p>
						</div>
					)}

					{transcriptionSettings.mode === "translate" && (
						<div className="mb-2">
							<label htmlFor="translate-target-language" className="mb-1 block text-sm font-medium">
								Target Language
							</label>
							<select
								id="translate-target-language"
								className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white transition-colors hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
								value={transcriptionSettings.translateTargetLanguage ?? "english"}
								onChange={(e) =>
									setTranscriptionSettings((prev) => ({
										...prev,
										translateTargetLanguage: e.target.value as "english",
									}))
								}
							>
								{_TRANSLATE_TARGET_LANGUAGES.map((lang) => (
									<option key={lang} value={lang}>
										{lang.charAt(0).toUpperCase() + lang.slice(1)}
									</option>
								))}
							</select>
							<p className="mt-1 text-xs text-muted-foreground">
								Translate audio to English (Whisper limitation)
							</p>
						</div>
					)}

					<div className="mb-3">
						<span className="mb-1 block text-sm font-medium">AI Model</span>
						<select
							value={transcriptionSettings.whisperModel}
							onChange={(e) => handleModelChange(e.target.value as WhisperModel)}
							className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white transition-colors hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
						>
							{Object.entries(WHISPER_MODELS).map(([key, label]) => (
								<option key={key} value={key}>
									{label}
								</option>
							))}
						</select>
						<p className="mt-1 text-xs text-muted-foreground">
							Auto picks the best model for your device. Base is recommended for stability.
						</p>
					</div>

					<label className="mb-1 flex cursor-pointer items-center gap-2">
						<input
							type="checkbox"
							checked={transcriptionSettings.includeMicrophone ?? false}
							disabled={isRecording || isModelBusy}
							onChange={(e) =>
								setTranscriptionSettings((prev) => ({ ...prev, includeMicrophone: e.target.checked }))
							}
							className="rounded"
						/>
						<span className="text-sm">Include microphone</span>
					</label>
					<p className="mb-3 text-xs text-muted-foreground">
						Mix your voice with tab audio for transcription
					</p>

					<label className="mb-1 flex cursor-pointer items-center gap-2">
						<input
							type="checkbox"
							checked={transcriptionSettings.speakerDetection ?? false}
							disabled={isRecording || isModelBusy}
							onChange={(e) =>
								setTranscriptionSettings((prev) => ({ ...prev, speakerDetection: e.target.checked }))
							}
							className="rounded"
						/>
						<span className="text-sm">Speaker detection (Beta)</span>
					</label>
					<p className="mb-3 text-xs text-muted-foreground">
						After Stop, detects speech turns (pauses) and labels 2 speakers. Speaker 1 is usually
						the person who talks the most. Best for interview-style dialogue with two distinct
						voices. Enable before Start.
					</p>

					<p className="mb-3 text-xs text-muted-foreground">
						For reliable capture: close the side panel, open YouTube, and click the extension icon on the
						tab with video.
					</p>

					{aiCapabilities.available === "no" && (
						<div className="mb-3 text-center text-sm">
							<p className="font-medium">AI Summarization is not available</p>
							<p className="text-xs text-muted-foreground">Please make sure your Chrome supports Prompt API.</p>
						</div>
					)}
					{aiCapabilities.available !== "no" && (
						<AiSummarizer
							setLanguage={(language: TranscriptionLanguage) =>
								setTranscriptionSettings((prev) => ({ ...prev, summarizationLanguage: language }))
							}
							language={transcriptionSettings.summarizationLanguage}
							isSummaryLoading={isSummaryLoading}
							handleSummarize={handleSummarize}
							summary={summary}
						/>
					)}
				</div>
			)}

			{modelStatus === "diarizing" && (
				<div className="mx-2 mb-1 shrink-0 rounded border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
					Processing speakers… This may take a minute after Stop.
				</div>
			)}

			<footer className="shrink-0 space-y-2 border-t border-border p-2">
				<div className="flex gap-2">
					<Button
						className="flex-1"
						variant={isRecording ? "outline" : "default"}
						disabled={isRecording || isModelBusy}
						onClick={handleStartTranscription}
					>
						{isRecording ? "Recording..." : isModelBusy ? "Please wait..." : "Start"}
					</Button>
					<Button
						className="flex-1"
						variant={isRecording ? "destructive" : "outline"}
						onClick={() => chrome.runtime.sendMessage({ type: "stop-transcription" })}
					>
						Stop
					</Button>
				</div>
				<Button
					className="w-full"
					variant="outline"
					onClick={() => {
						navigator.clipboard.writeText(transcription);
						toast({ description: "Copied to clipboard", color: "success", duration: 1000 });
					}}
				>
					Copy to Clipboard
				</Button>
			</footer>
		</div>
	);
};

export default SidePanelApp;
