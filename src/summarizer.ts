import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { TranscriptionLanguage } from "@/jotai/transcriptionSettings";
import {
	createSummaryBackend,
	needsTranslation,
	translateSummaryText,
} from "@/lib/chromeAi";

const MAX_INPUT_CHARS = 60_000;
const CHUNK_CHARS = 3_800;
const LONG_TEXT_SAMPLE_COUNT = 8;

const SUMMARY_SYSTEM_PROMPT =
	"You are a helpful assistant that summarizes web page content. Your output is markdown formatted. Summarize the main subject with bullet points and meaningful sections. Ignore navigation, advertisements, social links, and calls to action.";

const TRANSCRIPTION_SUMMARY_SYSTEM_PROMPT =
	"You are a helpful assistant that summarizes audio transcriptions. Your output is markdown formatted. Highlight key points, decisions, and action items. If speakers are labeled (e.g. Speaker 1, Speaker 2), note who said what when relevant.";

type YouTubePageContent = {
	text: string;
	kind: "transcript" | "metadata";
	title?: string;
};

function trimTextForSummary(text: string, maxChars = MAX_INPUT_CHARS): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}

	const omissionMarker = "\n\n[... section omitted due to length ...]\n\n";
	const availableChars = maxChars - omissionMarker.length * (LONG_TEXT_SAMPLE_COUNT - 1);
	const sampleSize = Math.floor(availableChars / LONG_TEXT_SAMPLE_COUNT);
	const maxOffset = trimmed.length - sampleSize;
	const samples = Array.from({ length: LONG_TEXT_SAMPLE_COUNT }, (_, index) => {
		const offset = Math.round((maxOffset * index) / (LONG_TEXT_SAMPLE_COUNT - 1));
		return trimmed.slice(offset, offset + sampleSize);
	});

	return samples.join(omissionMarker);
}

function splitLongBlock(block: string, chunkSize: number): string[] {
	const chunks: string[] = [];
	let remaining = block.trim();

	while (remaining.length > chunkSize) {
		const candidate = remaining.slice(0, chunkSize + 1);
		const boundaries = [
			candidate.lastIndexOf("\n"),
			candidate.lastIndexOf(". "),
			candidate.lastIndexOf("! "),
			candidate.lastIndexOf("? "),
			candidate.lastIndexOf(" "),
		];
		const naturalBoundary = Math.max(...boundaries);
		const splitAt = naturalBoundary >= chunkSize * 0.55 ? naturalBoundary + 1 : chunkSize;
		chunks.push(remaining.slice(0, splitAt).trim());
		remaining = remaining.slice(splitAt).trim();
	}

	if (remaining) chunks.push(remaining);
	return chunks;
}

function splitIntoChunks(text: string, chunkSize = CHUNK_CHARS): string[] {
	if (text.length <= chunkSize) {
		return [text];
	}

	const blocks = text
		.split(/\n{2,}/)
		.flatMap((paragraph) => splitLongBlock(paragraph, chunkSize));
	const chunks: string[] = [];
	let current = "";

	for (const block of blocks) {
		const next = current ? `${current}\n\n${block}` : block;
		if (next.length > chunkSize && current) {
			chunks.push(current);
			current = block;
		} else {
			current = next;
		}
	}

	if (current) chunks.push(current);
	return chunks;
}

async function summarizeText(
	text: string,
	options: {
		language: TranscriptionLanguage;
		systemPrompt: string;
		title?: string;
	},
): Promise<string> {
	const normalized = trimTextForSummary(text);
	if (!normalized) {
		throw new Error("No text to summarize");
	}

	const chunks = splitIntoChunks(normalized);
	const session = await createSummaryBackend(options.systemPrompt, options.language);

	try {
		const chunkSummaries: string[] = [];
		for (const [index, chunk] of chunks.entries()) {
			const partLabel = chunks.length > 1 ? ` (part ${index + 1} of ${chunks.length})` : "";
			const summary = await session.summarize(
				`Summarize the following text${partLabel}:\n\n${chunk}`,
			);
			chunkSummaries.push(summary);
		}

		let summary =
			chunkSummaries.length === 1
				? chunkSummaries[0]
				: await session.summarize(
						`Combine the following partial summaries into one cohesive markdown summary:\n\n${chunkSummaries.join("\n\n---\n\n")}`,
					);

		if (needsTranslation(session.backend, options.language)) {
			summary = await translateSummaryText(summary, options.language);
		}

		if (options.title) {
			return `${options.title}\n\n${summary}`;
		}

		return summary;
	} finally {
		session.destroy();
	}
}

export async function summarizeTranscription(
	transcription: string,
	language: TranscriptionLanguage,
): Promise<string> {
	const text = transcription.trim();
	if (!text) {
		throw new Error("Transcription is empty. Record or paste text first.");
	}

	return summarizeText(text, {
		language,
		systemPrompt: TRANSCRIPTION_SUMMARY_SYSTEM_PROMPT,
		title: "# Transcription Summary",
	});
}

function isYouTubeUrl(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const host = new URL(url).hostname.toLocaleLowerCase();
		return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
	} catch {
		return false;
	}
}

async function extractYouTubePageContent(tabId: number): Promise<YouTubePageContent | null> {
	const [{ result }] = await chrome.scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		func: async (): Promise<YouTubePageContent | null> => {
			type CaptionTrack = {
				baseUrl?: string;
				languageCode?: string;
				kind?: string;
			};
			type PlayerResponse = {
				videoDetails?: { title?: string; shortDescription?: string };
				captions?: {
					playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
				};
			};
			type CaptionResponse = {
				events?: Array<{ segs?: Array<{ utf8?: string }> }>;
			};
			type YouTubeWindow = typeof window & {
				ytInitialPlayerResponse?: PlayerResponse;
				ytInitialData?: unknown;
			};

			const pageWindow = window as YouTubeWindow;
			const playerResponse = pageWindow.ytInitialPlayerResponse;
			const title = playerResponse?.videoDetails?.title;

			const normalizeText = (value: string): string =>
				value.replace(/\s+/g, " ").replace(/\u200b/g, "").trim();

			const readRenderedTranscript = (): string => {
				const panel = document.querySelector(
					'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
				);
				if (!panel) return "";

				const renderers = Array.from(
					panel.querySelectorAll("ytd-transcript-segment-renderer"),
				);
				const rendererLines = renderers
					.map((renderer) => {
						const segment = renderer.querySelector("#segment-text")?.textContent;
						return normalizeText(segment ?? renderer.textContent ?? "").replace(
							/^\d{1,2}:\d{2}(?::\d{2})?\s*/,
							"",
						);
					})
					.filter((line) => line.length > 1);
				if (rendererLines.join(" ").length >= 120) {
					return rendererLines.join(" ");
				}

				const genericLines = Array.from(
					panel.querySelectorAll('[id*="segment-text"], [class*="segment-text"]'),
				)
					.map((element) => normalizeText(element.textContent ?? ""))
					.filter((line) => line.length > 1);
				return genericLines.join(" ").length >= 120 ? genericLines.join(" ") : "";
			};

			const renderedTranscript = readRenderedTranscript();
			if (renderedTranscript) {
				return { text: renderedTranscript, kind: "transcript", title };
			}

			const tracks =
				playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
			const track = tracks.find((item) => item.kind !== "asr") ?? tracks[0];
			if (track?.baseUrl) {
				try {
					const captionUrl = new URL(track.baseUrl);
					captionUrl.searchParams.set("fmt", "json3");
					if (track.languageCode && !captionUrl.searchParams.has("lang")) {
						captionUrl.searchParams.set("lang", track.languageCode);
					}
					const response = await fetch(captionUrl, { credentials: "include" });
					if (response.ok) {
						const captions = (await response.json()) as CaptionResponse;
						const captionText = normalizeText(
							(captions.events ?? [])
								.map((event) =>
									(event.segs ?? []).map((segment) => segment.utf8 ?? "").join(""),
								)
								.join(" "),
						);
						if (captionText.length >= 120) {
							return { text: captionText, kind: "transcript", title };
						}
					}
				} catch {
					// YouTube can require a per-session proof token for caption downloads.
				}
			}

			const transcriptSectionButton = document.querySelector<HTMLButtonElement>(
				"ytd-video-description-transcript-section-renderer button",
			);
			const localizedTranscriptButton = Array.from(
				document.querySelectorAll<HTMLButtonElement>("button"),
			).find((button) => {
				const label = `${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`;
				return /show transcript|показать текст видео|mostrar transcripci|transkript anzeigen|afficher la transcription|mostra trascrizione|文字起こし/iu.test(
					label,
				);
			});
			(transcriptSectionButton ?? localizedTranscriptButton)?.click();

			for (let attempt = 0; attempt < 20; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 200));
				const transcript = readRenderedTranscript();
				if (transcript) {
					return { text: transcript, kind: "transcript", title };
				}
			}

			const textFromRuns = (value: unknown): string => {
				if (!value || typeof value !== "object") return "";
				const record = value as Record<string, unknown>;
				if (typeof record.simpleText === "string") return record.simpleText;
				if (!Array.isArray(record.runs)) return "";
				return record.runs
					.map((run) =>
						run && typeof run === "object" && typeof (run as Record<string, unknown>).text === "string"
							? ((run as Record<string, unknown>).text as string)
							: "",
					)
					.join("");
			};

			const chapters: string[] = [];
			const visit = (value: unknown): void => {
				if (!value || typeof value !== "object") return;
				if (Array.isArray(value)) {
					for (const item of value) visit(item);
					return;
				}

				const record = value as Record<string, unknown>;
				const marker = record.macroMarkersListItemRenderer;
				if (marker && typeof marker === "object") {
					const markerRecord = marker as Record<string, unknown>;
					const chapterTitle = textFromRuns(markerRecord.title);
					const timestamp = textFromRuns(markerRecord.timeDescription);
					const line = normalizeText(`${timestamp} ${chapterTitle}`);
					if (line && !chapters.includes(line)) chapters.push(line);
				}

				for (const nested of Object.values(record)) visit(nested);
			};
			visit(pageWindow.ytInitialData);

			if (chapters.length > 0) {
				return {
					text: `Video chapters:\n${chapters.map((chapter) => `- ${chapter}`).join("\n")}`,
					kind: "metadata",
					title,
				};
			}

			const description = (playerResponse?.videoDetails?.shortDescription ?? "")
				.split("\n")
				.map((line) => line.replace(/https?:\/\/\S+/giu, "").replace(/#\S+/gu, "").trim())
				.filter((line) => (line.match(/[\p{L}\p{N}]/gu) ?? []).length >= 20)
				.slice(0, 30)
				.join("\n");
			return description ? { text: description, kind: "metadata", title } : null;
		},
	});

	return result ?? null;
}

function cleanArticleMarkdown(html: string, pageUrl: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const base = doc.createElement("base");
	base.href = pageUrl;
	doc.head.prepend(base);
	const article = new Readability(doc).parse();
	if (!article?.content) {
		throw new Error("Failed to extract readable content from the active page");
	}

	const turndownService = new TurndownService({
		headingStyle: "atx",
		bulletListMarker: "-",
	});
	turndownService.addRule("plain-links", {
		filter: "a",
		replacement: (content) => content,
	});
	turndownService.remove(["img", "script", "style", "noscript", "form", "button"]);

	return turndownService
		.turndown(article.content)
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
		.filter((line) => !/^https?:\/\/\S+$/iu.test(line.trim()))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export async function summarizeWebPage(language: TranscriptionLanguage): Promise<string> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab.id || !tab.url) {
		throw new Error("No active web page found");
	}

	let content = "";
	let metadataNotice = "";
	if (isYouTubeUrl(tab.url)) {
		const youtubeContent = await extractYouTubePageContent(tab.id);
		if (youtubeContent?.text) {
			content = youtubeContent.text;
			if (youtubeContent.kind === "metadata") {
				metadataNotice =
					"> YouTube transcript was unavailable, so this summary is based on the video description and chapters.\n\n";
			}
		}
	}

	if (!content) {
		const [{ result: html }] = await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			func: () => document.documentElement.outerHTML,
		});
		if (!html) {
			throw new Error("Failed to read the active page");
		}
		content = cleanArticleMarkdown(html, tab.url);
	}

	const title = tab.title?.trim() || "Web page";
	const summary = await summarizeText(content, {
		language,
		systemPrompt: SUMMARY_SYSTEM_PROMPT,
	});

	return `# [${title}](${tab.url})\n\n${metadataNotice}${summary}`;
}
