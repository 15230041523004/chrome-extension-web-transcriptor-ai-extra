export function safeRuntimeSendMessage(message: unknown): void {
	if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
		return;
	}

	try {
		chrome.runtime.sendMessage(message, () => {
			void chrome.runtime.lastError;
		});
	} catch {
		// Extension context invalidated.
	}
}

export async function hasOffscreenDocument(): Promise<boolean> {
	if (!chrome.runtime?.getContexts) {
		return false;
	}

	const contexts = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
	});

	return contexts.length > 0;
}

export async function sendToOffscreenIfPresent(message: unknown): Promise<void> {
	if (!(await hasOffscreenDocument())) {
		return;
	}

	safeRuntimeSendMessage(message);
	await new Promise((resolve) => setTimeout(resolve, 150));
}