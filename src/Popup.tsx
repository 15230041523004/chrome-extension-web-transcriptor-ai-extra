import type React from "react";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { AiSummarizer } from "./components/ai-summarizer";
import { Textarea } from "./components/ui/textarea";
import { useToast } from "./components/ui/use-toast";
import { transcriptionSettingsAtom, type TranscriptionLanguage } from "./jotai/settingAtom";
import { getAiSummarizationStatus } from "./lib/chromeAi";
import { summarizeTranscription, summarizeWebPage } from "./summarizer";

const Popup: React.FC = () => {
	const [summary, setSummary] = useState("");
	const [transcriptionSettings, setTranscriptionSettings] = useAtom(transcriptionSettingsAtom);
	const [isSummaryLoading, setIsSummaryLoading] = useState(false);
	const [aiStatus, setAiStatus] = useState({
		available: false,
		downloading: false,
	});
	const [transcription, setTranscription] = useState("");

	useEffect(() => {
		getAiSummarizationStatus().then((status) => {
			setAiStatus({
				available: status.available,
				downloading: status.downloading,
			});
		});

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
		return () => chrome.runtime.onMessage.removeListener(messageListener);
	}, []);

	const { toast } = useToast();

	const canSummarize =
		transcriptionSettings.summarizationSource === "webpage" ||
		transcription.trim().length > 0;

	const handleSummarize = async () => {
		setIsSummaryLoading(true);
		try {
			const result =
				transcriptionSettings.summarizationSource === "transcription"
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

				{!aiStatus.available ? (
					<div className="flex flex-col m-1 p-1">
						<div className="text-center">
							<h1>AI Summarization is not available</h1>
							<p>
								Use Chrome or Brave 138+ with on-device AI (Gemini Nano) enabled in browser
								settings.
							</p>
						</div>
					</div>
				) : (
					<div className="m-1 p-1">
						{aiStatus.downloading && (
							<p className="mb-2 text-xs text-muted-foreground">
								On-device AI model is downloading. The first summary may take longer.
							</p>
						)}
						<AiSummarizer
							language={transcriptionSettings.summarizationLanguage}
							setLanguage={(language: TranscriptionLanguage) =>
								setTranscriptionSettings((prev) => ({ ...prev, summarizationLanguage: language }))
							}
							source={transcriptionSettings.summarizationSource}
							setSource={(source) =>
								setTranscriptionSettings((prev) => ({ ...prev, summarizationSource: source }))
							}
							isSummaryLoading={isSummaryLoading}
							handleSummarize={handleSummarize}
							summary={summary}
							canSummarize={canSummarize}
						/>
					</div>
				)}
			</div>
		</div>
	);
};

export default Popup;