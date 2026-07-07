import { loadTranscriptionSettings } from "./jotai/transcriptionSettings";

const BUILD_TAG = "background-v6-sidepanel-capture";

let isRecording = false;
let offscreenReadyPromise: Promise<void> | null = null;

const isCapturableUrl = (url: string | undefined): boolean => {
	if (!url) return false;
	const blockedPrefixes = [
		"chrome://",
		"chrome-extension://",
		"about:",
		"edge://",
		"brave://",
		"devtools://",
		"view-source:",
	];
	return !blockedPrefixes.some((prefix) => url.startsWith(prefix));
};

const formatChromeError = (error: chrome.runtime.LastError | undefined): string => {
	if (!error) return "unknown error";
	return error.message || String(error);
};

const sendCaptureError = (error: string) => {
	isRecording = false;
	chrome.runtime.sendMessage({
		type: "capture-error",
		data: { error },
	});
	chrome.runtime.sendMessage({
		type: "recording-state",
		data: { recording: false },
	});
};

const stopRecording = (): void => {
	isRecording = false;
	chrome.runtime.sendMessage({ type: "stop-recording", target: "offscreen" });
	chrome.runtime.sendMessage({
		type: "recording-state",
		data: { recording: false },
	});
};

const ensureOffscreenDocument = async (): Promise<void> => {
	if (!offscreenReadyPromise) {
		offscreenReadyPromise = (async () => {
			const existingContexts = await chrome.runtime.getContexts({});
			const offscreenDocument = existingContexts.find(
				(c) => c.contextType === "OFFSCREEN_DOCUMENT",
			);
			if (offscreenDocument) return;

			await chrome.offscreen.createDocument({
				url: "offscreen.html",
				reasons: [chrome.offscreen.Reason.USER_MEDIA],
				justification: "Recording from chrome.tabCapture API",
			});
		})().catch((err) => {
			offscreenReadyPromise = null;
			throw err;
		});
	}

	await offscreenReadyPromise;
};

const deliverStreamToOffscreen = (streamId: string): void => {
	void (async () => {
		try {
			await ensureOffscreenDocument();
			const settings = await loadTranscriptionSettings();
			chrome.runtime.sendMessage({
				type: "start-recording",
				target: "offscreen",
				streamId,
				settings,
			});
		} catch (err) {
			console.error(`[${BUILD_TAG}] Failed to deliver stream to offscreen:`, err);
			sendCaptureError("Не удалось создать offscreen документ. Перезагрузите расширение.");
		}
	})();
};

const handleCaptureFailure = (detail: string, tabId?: number): void => {
	console.error(
		`[${BUILD_TAG}] getMediaStreamId failed${tabId !== undefined ? ` for tab ${tabId}` : ""}:`,
		detail,
	);

	if (detail.includes("active stream")) {
		stopRecording();
		chrome.runtime.sendMessage({ type: "prepare-capture", target: "offscreen" });
		sendCaptureError(
			"Вкладка уже захвачена. Нажмите Stop, подождите секунду и снова кликните по иконке расширения.",
		);
		return;
	}

	if (detail.includes("not been invoked") || detail.includes("activeTab")) {
		sendCaptureError(
			"Кликните по иконке расширения на вкладке с видео (YouTube и т.д.). Захват из side panel не разрешён Chrome для этой вкладки.",
		);
		return;
	}

	sendCaptureError(`Захват аудио отклонён Chrome: ${detail}`);
};

/**
 * Icon click: getMediaStreamId must run immediately in the onClicked handler.
 */
const beginRecordingFromIcon = (tab: chrome.tabs.Tab): void => {
	if (tab.id === undefined) return;

	if (!isCapturableUrl(tab.url)) {
		sendCaptureError(
			`Нельзя захватить эту страницу (${tab.url ?? "unknown"}). Откройте YouTube и кликните иконку расширения на этой вкладке.`,
		);
		return;
	}

	chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
		const captureError = chrome.runtime.lastError;
		if (captureError || !streamId) {
			handleCaptureFailure(formatChromeError(captureError), tab.id);
			return;
		}

		console.debug(`[${BUILD_TAG}] Stream ID acquired from icon click for tab ${tab.id}`);
		chrome.runtime.sendMessage({ type: "prepare-capture", target: "offscreen" });
		deliverStreamToOffscreen(streamId);
	});
};

const beginRecordingWithStreamId = (streamId: string): void => {
	chrome.runtime.sendMessage({ type: "prepare-capture", target: "offscreen" });
	deliverStreamToOffscreen(streamId);
};

chrome.runtime.onInstalled.addListener(() => {
	void ensureOffscreenDocument().catch((err) => {
		console.warn(`[${BUILD_TAG}] Offscreen pre-warm failed:`, err);
	});
});

chrome.runtime.onStartup.addListener(() => {
	void ensureOffscreenDocument().catch((err) => {
		console.warn(`[${BUILD_TAG}] Offscreen pre-warm failed:`, err);
	});
});

chrome.action.onClicked.addListener((tab) => {
	if (isRecording) {
		stopRecording();
		return;
	}

	beginRecordingFromIcon(tab);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.type === "start-with-stream-id") {
		const streamId = message.streamId as string | undefined;
		if (!streamId) {
			sendCaptureError("Не получен streamId. Попробуйте снова.");
			sendResponse({ success: false });
			return false;
		}

		if (isRecording) {
			stopRecording();
			sendResponse({ success: true, stopped: true });
			return false;
		}

		beginRecordingWithStreamId(streamId);
		sendResponse({ success: true });
		return false;
	}

	if (message.type === "stop-transcription") {
		stopRecording();
		sendResponse({ success: true });
		return false;
	}

	if (message.type === "get-recording-state") {
		sendResponse({ recording: isRecording });
		return false;
	}

	if (message.type === "recording-state") {
		isRecording = message.data?.recording ?? false;
		chrome.runtime.sendMessage({
			type: "recording-state",
			data: { recording: isRecording },
		});
		return false;
	}

	return false;
});

console.log(`[${BUILD_TAG}] Service worker loaded`);
void ensureOffscreenDocument().catch(() => {
	// Offscreen is created lazily on first capture if pre-warm fails.
});