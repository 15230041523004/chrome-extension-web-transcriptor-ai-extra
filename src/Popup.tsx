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
import { subscribeActiveBrowserTab } from "./lib/activeTab";
import {
	isYouTubeWatchUrl,
	summarizeTranscription,
	summarizeVideoTranscript,
	summarizeWebPage,
} from "./summarizer";

const Popup: React.FC = () => {
	const [summary, setSummary] = useState("");
	const [transcriptionSettings, setTranscriptionSettings] = useAtom(transcriptionSettingsAtom);
	const [isSummaryLoading, setIsSummaryLoading] = useState(false);
	const [summarizationSource, setSummarizationSource] =
		useState<SummarizationSource>("transcription");
	const [transcription, setTranscription] = useState("");
	const [activeTabUrl, setActiveTabUrl] = useState<string | undefined>(undefined);

	useEffect(() => {
		const unsubscribeActiveTab = subscribeActiveBrowserTab((tab) => {
			setActiveTabUrl(tab?.url);
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
		return () => {
			chrome.runtime.onMessage.removeListener(messageListener);
			unsubscribeActiveTab();
		};
	}, []);

	const { toast } = useToast();

	const isYouTubeTab = isYouTubeWatchUrl(activeTabUrl);

	useEffect(() => {
		if (!isYouTubeTab && summarizationSource === "videoTranscript") {
			setSummarizationSource("transcription");
		}
	}, [isYouTubeTab, summarizationSource]);

	const canSummarize =
		summarizationSource === "webpage" ||
		summarizationSource === "videoTranscript" ||
		transcription.trim().length > 0;

	const handleSummarize = async () => {
		setIsSummaryLoading(true);
		try {
			const language = transcriptionSettings.summarizationLanguage;
			let result: string;
			if (summarizationSource === "transcription") {
				result = await summarizeTranscription(transcription, language);
			} else if (summarizationSource === "videoTranscript") {
				result = await summarizeVideoTranscript(language);
			} else {
				result = await summarizeWebPage(language);
			}
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
			<div className="box-border h-auto w-100">
				<div className="flex flex-col m-1 p-1">
					<div className="text-center">
						<h1>Transcription</h1>
						<Textarea value={transcription} rows={10} readOnly />
					</div>
				</div>

				<div className="m-1 p-1">
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
						onClearSummary={() => setSummary("")}
						canSummarize={canSummarize}
						showVideoTranscriptSource={isYouTubeTab}
					/>
				</div>
			</div>
		</div>
	);
};

export default Popup;
