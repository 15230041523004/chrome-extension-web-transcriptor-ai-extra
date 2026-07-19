import type React from "react";
import { Loader2 } from "lucide-react";
import { LanguageSelector } from "./LanguageSelector";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/use-toast";
import { cn } from "@/lib/utils";
import type { SummarizationSource, TranscriptionLanguage } from "@/jotai/settingAtom";

interface AiSummarizerProps {
	language: TranscriptionLanguage;
	setLanguage: (language: TranscriptionLanguage) => void;
	source: SummarizationSource;
	setSource: (source: SummarizationSource) => void;
	isSummaryLoading: boolean;
	handleSummarize: () => Promise<void>;
	summary: string;
	canSummarize: boolean;
	hideTitle?: boolean;
	fillHeight?: boolean;
}

export const AiSummarizer: React.FC<AiSummarizerProps> = ({
	language,
	setLanguage,
	source,
	setSource,
	isSummaryLoading,
	handleSummarize,
	summary,
	canSummarize,
	hideTitle = false,
	fillHeight = false,
}) => {
	const summarizeLabel =
		source === "transcription" ? "Summarize transcription" : "Summarize web page";

	return (
		<div className={cn("flex flex-col gap-2", fillHeight && "h-full min-h-0")}>
			{!hideTitle && (
				<div className="flex items-center justify-between gap-2">
					<span className="text-sm font-medium">AI Summarization</span>
					<span className="text-xs text-muted-foreground">On-device AI</span>
				</div>
			)}

			<div>
				<span className="mb-1 block text-sm font-medium">Source</span>
				<div className="flex gap-4">
					<label className="flex cursor-pointer items-center gap-2">
						<input
							type="radio"
							name="summarization-source"
							checked={source === "transcription"}
							onChange={() => setSource("transcription")}
						/>
						<span className="text-sm">Transcription</span>
					</label>
					<label className="flex cursor-pointer items-center gap-2">
						<input
							type="radio"
							name="summarization-source"
							checked={source === "webpage"}
							onChange={() => setSource("webpage")}
						/>
						<span className="text-sm">Web page</span>
					</label>
				</div>
			</div>

			<div>
				<span className="mb-1 block text-sm font-medium">Summary Language</span>
				<LanguageSelector
					language={language}
					setLanguage={(lang) => {
						if (lang) setLanguage(lang);
					}}
				/>
			</div>

			<div className="flex justify-end">
				{isSummaryLoading ? (
					<Button disabled variant="outline">
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						Summarizing...
					</Button>
				) : (
					<Button onClick={handleSummarize} disabled={!canSummarize}>
						{summarizeLabel}
					</Button>
				)}
			</div>

			{source === "transcription" && !canSummarize && (
				<p className="text-xs text-muted-foreground">
					Record or paste transcription text before summarizing.
				</p>
			)}

			<Textarea
				value={summary}
				readOnly
				rows={fillHeight ? undefined : 8}
				className={cn("resize-none", fillHeight && "min-h-0 flex-1")}
			/>
			<Button
				variant="outline"
				disabled={!summary}
				onClick={() => {
					navigator.clipboard.writeText(summary).then(() => {
						toast({
							description: "Copied to clipboard",
						});
					});
				}}
			>
				Copy summary to clipboard
			</Button>
		</div>
	);
};