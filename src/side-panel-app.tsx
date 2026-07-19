import type React from "react";
import { useEffect, useRef, useState } from "react";
import { FileText, SlidersHorizontal, Sparkles } from "lucide-react";
import { AiSummarizer } from "./components/ai-summarizer";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { useToast } from "./components/ui/use-toast";
import { summarizeTranscription, summarizeWebPage } from "./summarizer";
import { LanguageSelector } from "./components/LanguageSelector";
import {
	type SummarizationSource,
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
import {
	type AiSummarizationStatus,
	getAiSummarizationStatus,
} from "./lib/chromeAi";
import {
	getLocalSummarizerState,
	subscribeLocalSummarizerState,
} from "./lib/localSummarizer";
import { DebugPanel } from "./components/debug-panel";
import { debugError, debugLog } from "./lib/debugLog";
import { normalizeModelProgress } from "./lib/modelProgress";

type ActivePanel = "transcript" | "ai" | "more";
type SecondaryView = "transcript" | "ai";

const SidePanelApp: React.FC = () => {
	const [summary, setSummary] = useState("");
	const [transcriptionSettings, setTranscriptionSettings] = useAtom(transcriptionSettingsAtom);
	const [isSummaryLoading, setIsSummaryLoading] = useState(false);
	const [summarizationSource, setSummarizationSource] =
		useState<SummarizationSource>("transcription");
	const [aiStatus, setAiStatus] = useState<AiSummarizationStatus>({
		available: true,
		backend: "local",
		downloading: false,
		reason: "api-missing",
		browserAiAvailable: false,
	});
	const [localSummarizerState, setLocalSummarizerState] = useState(
		getLocalSummarizerState,
	);
	const [transcription, setTranscription] = useState("");
	const [modelStatus, setModelStatus] = useAtom(modelStatusAtom);
	const [loadingProgress, setLoadingProgress] = useAtom(modelLoadingProgressAtom);
	const [loadedModelId, setLoadedModelId] = useAtom(loadedModelIdAtom);
	const [isRecording, setIsRecording] = useState(false);
	const [isStartingCapture, setIsStartingCapture] = useState(false);
	const [activeTabId, setActiveTabId] = useState<number | null>(null);
	const [activeTabUrl, setActiveTabUrl] = useState<string | undefined>(undefined);
	const [captureError, setCaptureError] = useState<string | null>(null);
	const [modelError, setModelError] = useState<string | null>(null);
	const [activePanel, setActivePanel] = useState<ActivePanel>("transcript");
	const [secondaryView, setSecondaryView] = useState<SecondaryView>("transcript");
	const transcriptionRef = useRef<HTMLTextAreaElement>(null);

	const selectPanel = (panel: ActivePanel) => {
		setActivePanel((current) => (current === panel && panel !== "transcript" ? "transcript" : panel));
	};

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
			setCaptureError("Could not detect the active tab. Switch to the tab with audio and try again.");
			return;
		}

		if (!isCapturableUrl(activeTabUrl)) {
			setCaptureError(
				`Cannot capture this page (${activeTabUrl ?? "unknown"}). Open a normal website tab with video/audio and try again.`,
			);
			return;
		}

		// Capture must run in the service worker. Calling tabCapture from the side panel
		// often fails (gesture / activeTab) and left recording stuck after partial starts.
		setCaptureError(null);
		setIsStartingCapture(true);
		debugLog("capture", "start-transcription via background", {
			tabId: activeTabId,
			tabUrl: activeTabUrl,
		});
		chrome.runtime.sendMessage(
			{
				type: "start-transcription",
				tabId: activeTabId,
				tabUrl: activeTabUrl,
			},
			() => {
				if (chrome.runtime.lastError) {
					setCaptureError(
						chrome.runtime.lastError.message ||
							"Background worker did not respond. Reload the extension from chrome://extensions.",
					);
				}
			},
		);
	};

	useEffect(() => {
		debugLog("side-panel-app", "useEffect mount");
		const unsubscribeLocalSummarizer = subscribeLocalSummarizerState(
			setLocalSummarizerState,
		);
		getAiSummarizationStatus()
			.then((status) => {
				debugLog("side-panel-app", "AI summarization status", status);
				setAiStatus(status);
			})
			.catch((error) => {
				debugError("side-panel-app", "getAiSummarizationStatus failed", error);
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
			(response?: { recording?: boolean; starting?: boolean }) => {
				if (response?.recording !== undefined) {
					setIsRecording(response.recording);
				}
				if (response?.starting !== undefined) {
					setIsStartingCapture(response.starting);
				}
			},
		);

		const messageListener = (message: any) => {
			// Skip noisy progress ticks in the debug log (they used to fill all 500 slots).
			if (
				message?.type !== "model-status" &&
				message?.type !== "transcript" &&
				message?.type !== "offscreen-ready" &&
				message?.type !== "start-recording" &&
				message?.type !== "capture-starting"
			) {
				debugLog("side-panel-app", "runtime message", message?.type ?? message);
			}
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
				const nextStatus =
					status === "loading" ||
					status === "ready" ||
					status === "error" ||
					status === "diarizing"
						? status
						: "unknown";
				setModelStatus((prev) => (prev === nextStatus ? prev : nextStatus));
				if (status === "error") {
					setModelError(typeof message.data?.message === "string" ? message.data.message : "Model error (see console)");
					setTimeout(() => setModelError(null), 8000);
				}
				if (status === "loading" || status === "diarizing") {
					const nextProgress = normalizeModelProgress(message.data?.progress);
					setLoadingProgress((prev) => (prev === nextProgress ? prev : nextProgress));
				}
				if (typeof message.data?.modelId === "string") {
					setLoadedModelId(message.data.modelId);
				}
			} else if (message.type === "recording-state") {
				setIsRecording(message.data?.recording ?? false);
				if (message.data?.recording) {
					setIsStartingCapture(false);
				}
			} else if (message.type === "capture-starting") {
				setIsStartingCapture(Boolean(message.data?.starting));
			} else if (message.type === "capture-error") {
				setCaptureError(typeof message.data?.error === "string" ? message.data.error : String(message.data?.error || "Unknown error"));
				setIsRecording(false);
				setIsStartingCapture(false);
				setTimeout(() => setCaptureError(null), 8000);
			}
		};
		chrome.runtime.onMessage.addListener(messageListener);
		return () => {
			debugLog("side-panel-app", "useEffect cleanup");
			chrome.runtime.onMessage.removeListener(messageListener);
			chrome.tabs.onActivated.removeListener(onTabActivated);
			chrome.tabs.onUpdated.removeListener(onTabUpdated);
			unsubscribeLocalSummarizer();
		};
	}, [setModelStatus, setLoadingProgress, setLoadedModelId]);

	useEffect(() => {
		// Snapshot only on meaningful UI transitions (not every transcript tick).
		debugLog("side-panel-app", "UI state snapshot", {
			activePanel,
			activeTabId,
			activeTabUrl,
			isRecording,
			isStartingCapture,
			modelStatus,
			aiAvailable: aiStatus.available,
		});
	}, [
		activePanel,
		activeTabId,
		activeTabUrl,
		isRecording,
		isStartingCapture,
		modelStatus,
		aiStatus.available,
	]);

	useEffect(() => {
		if (!transcriptionSettings.autoscroll) return;
		const textarea = transcriptionRef.current;
		if (textarea) {
			textarea.scrollTop = textarea.scrollHeight;
		}
	}, [transcription, transcriptionSettings.autoscroll]);

	const { toast } = useToast();

	const canSummarize =
		summarizationSource === "webpage" || transcription.trim().length > 0;

	const handleSummarize = async () => {
		setIsSummaryLoading(true);
		try {
			const result =
				summarizationSource === "transcription"
					? await summarizeTranscription(
							transcription,
							transcriptionSettings.summarizationLanguage,
						)
					: await summarizeWebPage(transcriptionSettings.summarizationLanguage);
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
	const isCaptureBusy = isRecording || isStartingCapture || isModelBusy;

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

	const renderTranscriptionPanel = (compact = false) => (
		<section className="flex min-h-0 flex-1 flex-col px-2 py-2">
			<div className="flex shrink-0 items-center gap-2">
				{!compact && <h1 className="shrink-0 text-base font-semibold">Transcription</h1>}
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
	);

	const renderAiPanel = (fillHeight = false) => (
		<div className={fillHeight ? "flex min-h-0 flex-1 flex-col px-2 py-2" : "px-2 py-2"}>
			{(aiStatus.backend === "local" || localSummarizerState.status !== "idle") && (
				<p className="mb-2 text-xs text-muted-foreground">
					{localSummarizerState.status === "loading"
						? `Downloading local on-device model${
								localSummarizerState.progress > 0
									? ` (${localSummarizerState.progress}%)`
									: ""
							}. The first summary may take longer.`
						: "Using local on-device summarization. Brave does not expose Chrome's Gemini Nano APIs."}
				</p>
			)}
			{aiStatus.backend !== "local" &&
				localSummarizerState.status === "idle" &&
				aiStatus.downloading && (
					<p className="mb-2 text-xs text-muted-foreground">
						Browser AI model is downloading. The first summary may take longer.
					</p>
				)}
			<AiSummarizer
				language={transcriptionSettings.summarizationLanguage}
				setLanguage={(language: TranscriptionLanguage) =>
					setTranscriptionSettings((prev) => ({ ...prev, summarizationLanguage: language }))
				}
				source={summarizationSource}
				setSource={setSummarizationSource}
				isSummaryLoading={isSummaryLoading}
				handleSummarize={handleSummarize}
				summary={summary}
				canSummarize={canSummarize && !isRecording && !isModelBusy}
				hideTitle
				fillHeight={fillHeight}
			/>
		</div>
	);

	const renderMoreSettings = () => (
		<>
			<label className="mb-3 flex cursor-pointer items-center gap-2">
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

			<p className="text-xs text-muted-foreground">
				Start from this panel, or click the extension icon on the tab with video/audio.
			</p>
		</>
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
			<div className="grid shrink-0 grid-cols-3 gap-1 border-b border-border p-2">
				<Button
					type="button"
					variant={activePanel === "transcript" ? "default" : "outline"}
					onClick={() => selectPanel("transcript")}
					className="h-auto gap-1.5 px-2 py-2 text-xs"
				>
					<FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
					<span>Transcript</span>
				</Button>
				<Button
					type="button"
					variant={activePanel === "ai" ? "default" : "outline"}
					onClick={() => selectPanel("ai")}
					className="h-auto gap-1.5 px-2 py-2 text-xs"
				>
					<Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
					<span>Summary</span>
				</Button>
				<Button
					type="button"
					variant={activePanel === "more" ? "default" : "outline"}
					onClick={() => selectPanel("more")}
					className="h-auto gap-1.5 px-2 py-2 text-xs"
				>
					<SlidersHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
					<span>Options</span>
				</Button>
			</div>

			{captureError && (
				<div
					role="alert"
					className="mx-2 mt-2 shrink-0 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm leading-snug text-destructive dark:border-red-700 dark:bg-red-950/50 dark:text-red-100"
				>
					{captureError}
				</div>
			)}
			{modelError && (
				<div
					role="alert"
					className="mx-2 mt-2 shrink-0 rounded-md border border-amber-600/50 bg-amber-500/15 p-3 text-sm leading-snug text-amber-950 dark:border-orange-700 dark:bg-orange-950/50 dark:text-orange-100"
				>
					{modelError}
				</div>
			)}
			{modelStatus === "diarizing" && (
				<div className="mx-2 mt-2 shrink-0 rounded border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
					Processing speakers… This may take a minute after Stop.
				</div>
			)}

			<div className="flex min-h-0 flex-1 flex-col">
				{activePanel === "transcript" && renderTranscriptionPanel()}
				{activePanel === "ai" && renderAiPanel(true)}
				{activePanel === "more" && (
					<div className="flex min-h-0 flex-1 flex-col">
						<div className="max-h-[42%] min-h-0 shrink-0 overflow-y-auto border-b border-border px-2 py-2">
							{renderMoreSettings()}
						</div>
						<div className="flex min-h-0 flex-1 flex-col">
							<div className="grid shrink-0 grid-cols-2 gap-1 border-b border-border px-2 py-1">
								<Button
									type="button"
									size="sm"
									variant={secondaryView === "transcript" ? "secondary" : "ghost"}
									onClick={() => setSecondaryView("transcript")}
								>
									Transcript
								</Button>
								<Button
									type="button"
									size="sm"
									variant={secondaryView === "ai" ? "secondary" : "ghost"}
									onClick={() => setSecondaryView("ai")}
								>
									Summary
								</Button>
							</div>
							<div className="flex min-h-0 flex-1 flex-col">
								{secondaryView === "transcript"
									? renderTranscriptionPanel(true)
									: renderAiPanel(true)}
							</div>
						</div>
					</div>
				)}
			</div>

			<footer className="relative shrink-0 border-t border-border p-2 pb-0 pr-0">
				<div className="space-y-2 pb-2 pr-2">
				<div className="flex gap-2">
					<Button
						className="flex-1"
						variant={isRecording ? "outline" : "default"}
						disabled={isCaptureBusy}
						onClick={handleStartTranscription}
					>
						{isRecording
							? "Recording..."
							: isStartingCapture
								? "Starting..."
								: isModelBusy
									? "Please wait..."
									: "Start"}
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
				</div>
				<DebugPanel />
			</footer>
		</div>
	);
};

export default SidePanelApp;
