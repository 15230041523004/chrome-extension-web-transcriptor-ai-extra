import type React from "react";
import { useState } from "react";
import { useAtom } from "jotai";
import { Loader2 } from "lucide-react";
import { LanguageSelector } from "./LanguageSelector";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/use-toast";
import { cn } from "@/lib/utils";
import type { SummarizationSource, TranscriptionLanguage } from "@/jotai/settingAtom";
import {
	cloudAiSettingsAtom,
	DEFAULT_CLOUD_AI_SETTINGS,
	LOCAL_SUMMARY_MODELS,
	normalizeSummarySettings,
	type LocalSummaryModel,
} from "@/lib/cloudAiSettings";
import { releaseLocalAiCaches } from "@/lib/localSummarizer";
import { extractSummarySection } from "@/lib/summaryFeedback";

interface AiSummarizerProps {
	language: TranscriptionLanguage;
	setLanguage: (language: TranscriptionLanguage) => void;
	source: SummarizationSource;
	setSource: (source: SummarizationSource) => void;
	isSummaryLoading: boolean;
	handleSummarize: () => Promise<void>;
	summary: string;
	canSummarize: boolean;
	/** Shown on hover when the summarize button is disabled (e.g. recording). */
	summarizeDisabledReason?: string;
	showVideoTranscriptSource?: boolean;
	hideTitle?: boolean;
	fillHeight?: boolean;
	/** Clear the displayed summary output. */
	onClearSummary?: () => void;
}

const VIDEO_TRANSCRIPT_HINT =
	"Uses YouTube captions matching Summary Language when available. May open the video transcript panel on the page.";

export const AiSummarizer: React.FC<AiSummarizerProps> = ({
	language,
	setLanguage,
	source,
	setSource,
	isSummaryLoading,
	handleSummarize,
	summary,
	canSummarize,
	summarizeDisabledReason,
	showVideoTranscriptSource = false,
	hideTitle = false,
	fillHeight = false,
	onClearSummary,
}) => {
	const [cloudSettings, setCloudSettings] = useAtom(cloudAiSettingsAtom);
	const [showAdvanced, setShowAdvanced] = useState(false);

	const patchSettings = (patch: Partial<typeof cloudSettings>) => {
		setCloudSettings(normalizeSummarySettings({ ...cloudSettings, ...patch }));
	};

	const summarizeLabel =
		source === "transcription"
			? "Summarize transcription"
			: source === "videoTranscript"
				? "Summarize video transcript"
				: "Summarize web page";

	const summarizeDisabled = !canSummarize || isSummaryLoading;
	const summarizeTitle =
		summarizeDisabled && summarizeDisabledReason
			? summarizeDisabledReason
			: source === "videoTranscript"
				? VIDEO_TRANSCRIPT_HINT
				: undefined;

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
				<div className="flex flex-wrap gap-4">
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
					<label
						className={`flex items-center gap-2 ${
							showVideoTranscriptSource
								? "cursor-pointer"
								: "cursor-not-allowed opacity-60"
						}`}
						title={
							showVideoTranscriptSource
								? VIDEO_TRANSCRIPT_HINT
								: "Open a YouTube video tab to enable this source"
						}
					>
						<input
							type="radio"
							name="summarization-source"
							checked={source === "videoTranscript"}
							disabled={!showVideoTranscriptSource}
							onChange={() => {
								if (showVideoTranscriptSource) setSource("videoTranscript");
							}}
						/>
						<span className="text-sm">Video transcript</span>
					</label>
				</div>
				{!showVideoTranscriptSource && (
					<p className="mt-1 text-xs text-muted-foreground">
						Video transcript is available when the active tab is YouTube.
					</p>
				)}
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

			<div className="rounded-md border border-border p-2">
				<button
					type="button"
					className="w-full text-left text-sm font-medium"
					onClick={() => setShowAdvanced((v) => !v)}
				>
					{showAdvanced ? "▾" : "▸"} Summary settings
				</button>
				{showAdvanced && (
					<div className="mt-2 flex flex-col gap-3">
						<div>
							<label
								htmlFor="local-summary-model"
								className="mb-1 block text-sm font-medium"
							>
								Local AI Model
							</label>
							<select
								id="local-summary-model"
								className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
								value={cloudSettings.localSummaryModel}
								onChange={(event) =>
									patchSettings({
										localSummaryModel: event.target.value as LocalSummaryModel,
									})
								}
							>
								{Object.entries(LOCAL_SUMMARY_MODELS).map(([value, model]) => (
									<option key={value} value={value}>
										{model.label}
									</option>
								))}
							</select>
							<p className="mt-1 text-xs text-muted-foreground">
								{LOCAL_SUMMARY_MODELS[cloudSettings.localSummaryModel].description}.
								The model is downloaded once and cached in the browser.
							</p>
						</div>

						<p className="text-xs text-muted-foreground">
							Target ~{Math.round(cloudSettings.summaryRatioTarget * 100)}% of
							source · {cloudSettings.chronoWindows} windows · max{" "}
							{cloudSettings.maxBullets} bullets. Full-outline always keeps
							last-third coverage when units allow.
						</p>

						<label className="flex flex-col gap-1">
							<span className="text-sm">
								Target length (% of source):{" "}
								{Math.round(cloudSettings.summaryRatioTarget * 100)}%
							</span>
							<input
								type="range"
								min={3}
								max={25}
								step={1}
								value={Math.round(cloudSettings.summaryRatioTarget * 100)}
								onChange={(e) =>
									patchSettings({
										summaryRatioTarget: Number(e.target.value) / 100,
									})
								}
							/>
						</label>

						<div className="grid grid-cols-2 gap-2">
							<label className="flex flex-col gap-1">
								<span className="text-xs text-muted-foreground">Min length %</span>
								<input
									type="number"
									min={2}
									max={15}
									step={1}
									className="h-8 rounded-md border border-input bg-background px-2 text-sm"
									value={Math.round(cloudSettings.summaryRatioMin * 100)}
									onChange={(e) =>
										patchSettings({
											summaryRatioMin: Number(e.target.value) / 100,
										})
									}
								/>
							</label>
							<label className="flex flex-col gap-1">
								<span className="text-xs text-muted-foreground">Max length %</span>
								<input
									type="number"
									min={8}
									max={40}
									step={1}
									className="h-8 rounded-md border border-input bg-background px-2 text-sm"
									value={Math.round(cloudSettings.summaryRatioMax * 100)}
									onChange={(e) =>
										patchSettings({
											summaryRatioMax: Number(e.target.value) / 100,
										})
									}
								/>
							</label>
							<label className="flex flex-col gap-1">
								<span className="text-xs text-muted-foreground">
									Chrono windows (splits)
								</span>
								<input
									type="number"
									min={2}
									max={16}
									step={1}
									className="h-8 rounded-md border border-input bg-background px-2 text-sm"
									value={cloudSettings.chronoWindows}
									onChange={(e) =>
										patchSettings({
											chronoWindows: Number(e.target.value),
										})
									}
								/>
							</label>
							<label className="flex flex-col gap-1">
								<span className="text-xs text-muted-foreground">Max bullets</span>
								<input
									type="number"
									min={4}
									max={40}
									step={1}
									className="h-8 rounded-md border border-input bg-background px-2 text-sm"
									value={cloudSettings.maxBullets}
									onChange={(e) =>
										patchSettings({
											maxBullets: Number(e.target.value),
										})
									}
								/>
							</label>
							<label className="flex flex-col gap-1">
								<span className="text-xs text-muted-foreground">Min bullets</span>
								<input
									type="number"
									min={1}
									max={10}
									step={1}
									className="h-8 rounded-md border border-input bg-background px-2 text-sm"
									value={cloudSettings.minBullets}
									onChange={(e) =>
										patchSettings({
											minBullets: Number(e.target.value),
										})
									}
								/>
							</label>
							<label className="flex flex-col gap-1">
								<span className="text-xs text-muted-foreground">
									Max chars / bullet (≥280)
								</span>
								<input
									type="number"
									min={280}
									max={900}
									step={20}
									className="h-8 rounded-md border border-input bg-background px-2 text-sm"
									value={cloudSettings.maxBulletChars}
									onChange={(e) =>
										patchSettings({
											maxBulletChars: Number(e.target.value),
										})
									}
								/>
							</label>
						</div>

						<label className="flex cursor-pointer items-center gap-2">
							<input
								type="checkbox"
								checked={cloudSettings.includePipelineDebug}
								onChange={(e) =>
									patchSettings({
										includePipelineDebug: e.target.checked,
									})
								}
							/>
							<span className="text-sm">
								Show pipeline debug (Stages 1–3) — off: final summary only
							</span>
						</label>
						<label className="flex cursor-pointer items-center gap-2">
							<input
								type="checkbox"
								checked={cloudSettings.allowBrowserAi}
								onChange={(e) =>
									patchSettings({
										allowBrowserAi: e.target.checked,
									})
								}
							/>
							<span className="text-sm">
								Allow browser AI two-pass (when available)
							</span>
						</label>
						<label className="flex cursor-pointer items-center gap-2">
							<input
								type="checkbox"
								checked={cloudSettings.allowPolish}
								onChange={(e) =>
									patchSettings({
										allowPolish: e.target.checked,
									})
								}
							/>
							<span className="text-sm">
								Allow grounded polish of extractive notes
							</span>
						</label>

						<div className="flex flex-wrap gap-2 pt-1">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									setCloudSettings({ ...DEFAULT_CLOUD_AI_SETTINGS });
									toast({ description: "Summary settings reset to defaults" });
								}}
							>
								Reset settings
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									void releaseLocalAiCaches()
										.then(() =>
											toast({
												description:
													"Local model caches cleared (re-download on next run)",
											}),
										)
										.catch(() =>
											toast({ description: "Could not clear model caches" }),
										);
								}}
							>
								Clear model cache
							</Button>
						</div>

						<p className="text-xs text-muted-foreground">
							Local only: E5 / TextRank extractive by default. Browser AI is
							optional and fail-closed. Online cloud polish is not used.
						</p>
					</div>
				)}
			</div>

			<div className="flex flex-wrap justify-end gap-2">
				{onClearSummary && (
					<Button
						type="button"
						variant="outline"
						disabled={!summary.trim() || isSummaryLoading}
						onClick={() => {
							onClearSummary();
							toast({ description: "Summary cleared" });
						}}
					>
						Clear summary
					</Button>
				)}
				{/* span wrapper so title works on disabled buttons */}
				<span
					className="inline-flex"
					title={summarizeTitle}
				>
					{isSummaryLoading ? (
						<Button disabled variant="outline">
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							Summarizing...
						</Button>
					) : (
						<Button
							onClick={handleSummarize}
							disabled={summarizeDisabled}
							title={summarizeTitle}
						>
							{summarizeLabel}
						</Button>
					)}
				</span>
			</div>

			{source === "transcription" && !canSummarize && !summarizeDisabledReason && (
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
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					disabled={!summary}
					onClick={() => {
						const text = extractSummarySection(summary) || summary;
						navigator.clipboard.writeText(text).then(() => {
							toast({
								description: "Copied summary to clipboard",
							});
						});
					}}
				>
					Copy summary to clipboard
				</Button>
			</div>
		</div>
	);
};
