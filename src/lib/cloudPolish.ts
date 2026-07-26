/**
 * Online cloud polish is intentionally disabled.
 * Summarization uses browser AI (when available) and local extractive models only.
 */

import type { TranscriptionLanguage } from "@/jotai/transcriptionSettings";

/**
 * @deprecated Online polish removed. Always returns null.
 */
export async function polishWithCloudAi(
	_bulletsMarkdown: string,
	_language: TranscriptionLanguage,
	_title = "",
): Promise<string | null> {
	return null;
}
