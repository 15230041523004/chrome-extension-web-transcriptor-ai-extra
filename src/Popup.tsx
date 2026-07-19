import type React from "react";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { AiSummarizer } from "./components/ai-summarizer";
import { Textarea } from "./components/ui/textarea";
import { useToast } from "./components/ui/use-toast";
import {
	type SummarizationSource,
	transcriptionSettingsAtom,
	type TranscriptionLanguage,
} from "./jotai/settingAtom";
import {
	type AiSummarizationStatus,
	getAiSummarizationStatus,
} from "./lib/chromeAi";
import {
	getLocalSummarizerState,
	subscribeLocalSummarizerState,
} from "./lib/localSummarizer";
import { summarizeTranscription, summarizeWebPage } from "./summarizer";

const Popup: React.FC = () => {
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

	useEffect(() => {
		const unsubscribeLocalSummarizer = subscribeLocalSummarizerState(
			setLocalSummarizerState,
		);
		getAiSummarizationStatus().then(setAiStatus);

		const messageListener = (message: { type?: string; data?: { transcripted?: string } }) => {
			if (message.type === "transcript") {
				const next = (message.data?.transcripted ?? "").trim();
				if (!next) return;
				setTranscription((prev) => (prev ? `${prev}\n${next}` : next));
			} else if (message.type === "transcript-diarized") {
				const next = (message.data?.transcripted ?? "").trim();
				if (!next) return;
				setTranscription(next);
			}
		};

		chrome.runtime.onMessage.addListener(messageListener);
		return () => {
			chrome.runtime.onMessage.removeListener(messageListener);
			unsubscribeLocalSummarizer();
		};
	}, []);

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
			toast({
				description: "Summarized",
				color: "success",
			});
		} catch (error) {
			console.error(error);
			setSummary(`Failed to summarize: ${error}`);
			toast({
				description: "Failed to summarize",
				color: "error",
			});
		} finally {
			setIsSummaryLoading(false);
		}
	};

	return (
		<div className="container">
			<div className="box-border h-auto w-[400px]">
				<div className="flex flex-col m-1 p-1">
					<div className="text-center">
						<h1>Transcription</h1>
						<Textarea value={transcription} rows={10} readOnly />
					</div>
				</div>

				<div className="m-1 p-1">
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
						canSummarize={canSummarize}
					/>
				</div>
			</div>
		</div>
	);
};

export default Popup;