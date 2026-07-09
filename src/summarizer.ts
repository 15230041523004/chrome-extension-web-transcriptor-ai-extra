import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { TranscriptionLanguage } from "@/jotai/transcriptionSettings";
import {
	createSummaryBackend,
	needsTranslation,
	translateSummaryText,
} from "@/lib/chromeAi";

const MAX_INPUT_CHARS = 10_000;
const CHUNK_CHARS = 4_000;
const WEB_PAGE_MAX_LINES = 40;

const SUMMARY_SYSTEM_PROMPT =
	"You are a helpful assistant that summarizes text. Your output is markdown formatted. Summarize with bullet points and meaningful sections.";

const TRANSCRIPTION_SUMMARY_SYSTEM_PROMPT =
	"You are a helpful assistant that summarizes audio transcriptions. Your output is markdown formatted. Highlight key points, decisions, and action items. If speakers are labeled (e.g. Speaker 1, Speaker 2), note who said what when relevant.";

function trimTextForSummary(text: string, maxChars = MAX_INPUT_CHARS): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}

	const headSize = Math.floor(maxChars * 0.6);
	const tailSize = maxChars - headSize - 64;
	return `${trimmed.slice(0, headSize)}\n\n[... middle section omitted due to length ...]\n\n${trimmed.slice(-tailSize)}`;
}

function splitIntoChunks(text: string, chunkSize = CHUNK_CHARS): string[] {
	if (text.length <= chunkSize) {
		return [text];
	}

	const chunks: string[] = [];
	const paragraphs = text.split(/\n{2,}/);
	let current = "";

	for (const paragraph of paragraphs) {
		const next = current ? `${current}\n\n${paragraph}` : paragraph;
		if (next.length > chunkSize && current) {
			chunks.push(current);
			current = paragraph;
		} else {
			current = next;
		}
	}

	if (current) {
		chunks.push(current);
	}

	if (chunks.length === 0) {
		for (let offset = 0; offset < text.length; offset += chunkSize) {
			chunks.push(text.slice(offset, offset + chunkSize));
		}
	}

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

export async function summarizeWebPage(language: TranscriptionLanguage): Promise<string> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab.id) {
		throw new Error("No active tab found");
	}

	const [{ result: content }] = await chrome.scripting.executeScript({
		target: { tabId: tab.id },
		func: () => document.documentElement.outerHTML,
	});

	if (!content) {
		throw new Error("Failed to get content from the active tab");
	}

	const doc = new DOMParser().parseFromString(content, "text/html");
	const reader = new Readability(doc);
	const article = reader.parse();

	if (!article?.content) {
		throw new Error("Failed to extract article content");
	}

	const turndownService = new TurndownService();
	const markdown = turndownService.turndown(article.content);
	const markdownLines = markdown.split("\n");

	if (markdownLines.length > WEB_PAGE_MAX_LINES) {
		markdownLines.splice(WEB_PAGE_MAX_LINES);
	}

	const titleAndUrl = `# [${tab.title}](${tab.url})\n\n`;
	const summary = await summarizeText(markdownLines.join("\n"), {
		language,
		systemPrompt: SUMMARY_SYSTEM_PROMPT,
	});

	return titleAndUrl + summary;
}