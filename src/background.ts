import { loadTranscriptionSettings } from "./jotai/transcriptionSettings";
import {
	debugError,
	debugLog,
	debugWarn,
	getDebugLogText,
	loadPersistedDebugLog,
	setDebugLogContext,
} from "./lib/debugLog";
import {
	safeRuntimeSendMessage,
	sendToOffscreenIfPresent,
} from "./lib/runtimeMessaging";

const BUILD_TAG = "background-v9-launch-ready";
const RELEASE_CAPTURE_DELAY_MS = 600;
const PANEL_READY_CAPTURE_TIMEOUT_MS = 1200;

let isRecording = false;
let offscreenReadyPromise: Promise<void> | null = null;
let pendingCapture: { streamId: string } | null = null;
let pendingCaptureTimer: ReturnType<typeof setTimeout> | null = null;

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
	debugError("background", "capture error", error);
	isRecording = false;
	safeRuntimeSendMessage({
		type: "capture-error",
		data: { error },
	});
	safeRuntimeSendMessage({
		type: "recording-state",
		data: { recording: false },
	});
};

const openSidePanelForTab = (tabId?: number): void => {
	debugLog("background", "openSidePanelForTab called", { tabId });
	if (!chrome.sidePanel?.open) {
		debugWarn("background", "chrome.sidePanel.open unavailable");
		return;
	}

	const tryOpen = (targetTabId: number) => {
		const openPanel = () => {
			chrome.sidePanel.open({ tabId: targetTabId }, () => {
				if (chrome.runtime.lastError) {
					debugError("background", "sidePanel.open failed", chrome.runtime.lastError.message);
				} else {
					debugLog("background", "sidePanel.open success", { tabId: targetTabId });
				}
			});
		};

		if (chrome.sidePanel.setOptions) {
			chrome.sidePanel.setOptions(
				{
					tabId: targetTabId,
					path: "sidepanel.html",
					enabled: true,
				},
				() => {
					void chrome.runtime.lastError;
					openPanel();
				},
			);
			return;
		}

		openPanel();
	};

	if (tabId !== undefined) {
		tryOpen(tabId);
		return;
	}

	chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
		const targetTabId = tabs[0]?.id;
		if (targetTabId !== undefined) {
			tryOpen(targetTabId);
		}
	});
};

const closeOffscreenDocument = async (): Promise<void> => {
	offscreenReadyPromise = null;
	const existingContexts = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
	});
	if (existingContexts.length === 0) return;
	await chrome.offscreen.closeDocument();
};

const releaseActiveCapture = async (): Promise<void> => {
	debugLog("background", "releaseActiveCapture start");
	isRecording = false;
	await sendToOffscreenIfPresent({ type: "stop-recording", target: "offscreen" });
	await sendToOffscreenIfPresent({ type: "prepare-capture", target: "offscreen" });
	await new Promise((resolve) => setTimeout(resolve, RELEASE_CAPTURE_DELAY_MS));
	await closeOffscreenDocument();
	safeRuntimeSendMessage({
		type: "recording-state",
		data: { recording: false },
	});
	debugLog("background", "releaseActiveCapture done");
};

const stopRecording = (): void => {
	debugLog("background", "stopRecording");
	void releaseActiveCapture();
};

const ensureOffscreenDocument = async (): Promise<void> => {
	if (!offscreenReadyPromise) {
		offscreenReadyPromise = (async () => {
			const existingContexts = await chrome.runtime.getContexts({
				contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
			});
			if (existingContexts.length > 0) return;

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

const configureExtension = (): void => {
	if (chrome.sidePanel?.setOptions) {
		chrome.sidePanel.setOptions(
			{
				path: "sidepanel.html",
				enabled: true,
			},
			() => {
				if (chrome.runtime.lastError) {
					debugWarn("background", "sidePanel.setOptions failed", chrome.runtime.lastError.message);
				} else {
					debugLog("background", "sidePanel default options configured");
				}
			},
		);
	}
};

const shutdownExtensionResources = (): void => {
	void releaseActiveCapture();
};

const clearPendingCaptureTimer = (): void => {
	if (pendingCaptureTimer !== null) {
		clearTimeout(pendingCaptureTimer);
		pendingCaptureTimer = null;
	}
};

const flushPendingCapture = (): void => {
	clearPendingCaptureTimer();
	if (!pendingCapture) {
		debugLog("background", "flushPendingCapture: nothing pending");
		return;
	}

	const { streamId } = pendingCapture;
	debugLog("background", "flushPendingCapture", { streamIdPreview: `${streamId.slice(0, 8)}...` });
	pendingCapture = null;
	void sendToOffscreenIfPresent({ type: "prepare-capture", target: "offscreen" });
	deliverStreamToOffscreen(streamId, true);
};

const queueCaptureUntilPanelReady = (streamId: string): void => {
	debugLog("background", "queueCaptureUntilPanelReady", {
		streamIdPreview: `${streamId.slice(0, 8)}...`,
		timeoutMs: PANEL_READY_CAPTURE_TIMEOUT_MS,
	});
	pendingCapture = { streamId };
	clearPendingCaptureTimer();
	pendingCaptureTimer = setTimeout(() => {
		debugWarn("background", "Side panel ready timeout; starting capture anyway");
		flushPendingCapture();
	}, PANEL_READY_CAPTURE_TIMEOUT_MS);
};

const deliverStreamToOffscreen = (streamId: string, immediate = false): void => {
	debugLog("background", "deliverStreamToOffscreen", { immediate });
	void (async () => {
		try {
			if (!immediate) {
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
			debugLog("background", "ensureOffscreenDocument start");
			await ensureOffscreenDocument();
			debugLog("background", "ensureOffscreenDocument done");
			const settings = await loadTranscriptionSettings();
			isRecording = true;
			safeRuntimeSendMessage({
				type: "start-recording",
				target: "offscreen",
				streamId,
				settings,
			});
		} catch (err) {
			debugError("background", "deliverStreamToOffscreen failed", err);
			sendCaptureError("Failed to create the offscreen document. Reload the extension.");
		}
	})();
};

const handleCaptureFailure = (detail: string, tabId?: number): void => {
	debugError("background", "getMediaStreamId failed", { tabId, detail });

	if (tabId !== undefined) {
		openSidePanelForTab(tabId);
	}

	if (detail.includes("active stream")) {
		sendCaptureError(
			"This tab is already being captured. Press Stop, wait a second, and try again.",
		);
		return;
	}

	if (detail.includes("not been invoked") || detail.includes("activeTab")) {
		sendCaptureError(
			"Click the extension icon on the tab with video (e.g. YouTube). Chrome does not allow capture from the side panel for this tab.",
		);
		return;
	}

	sendCaptureError(`Chrome rejected audio capture: ${detail}`);
};

const requestMediaStreamId = (
	tabId: number,
	onSuccess: (streamId: string) => void,
	retrying = false,
): void => {
	chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
		const captureError = chrome.runtime.lastError;
		if (captureError || !streamId) {
			const detail = formatChromeError(captureError);
			if (!retrying && detail.includes("active stream")) {
				void releaseActiveCapture().then(() => {
					requestMediaStreamId(tabId, onSuccess, true);
				});
				return;
			}
			handleCaptureFailure(detail, tabId);
			return;
		}

		onSuccess(streamId);
	});
};

/**
 * Icon click: getMediaStreamId must run immediately in the onClicked handler.
 */
const beginRecordingFromIcon = (tab: chrome.tabs.Tab): void => {
	if (tab.id === undefined) return;

	if (!isCapturableUrl(tab.url)) {
		openSidePanelForTab(tab.id);
		sendCaptureError(
			`Cannot capture this page (${tab.url ?? "unknown"}). Open YouTube and click the extension icon on that tab.`,
		);
		return;
	}

	requestMediaStreamId(tab.id, (streamId) => {
		debugLog("background", "Stream ID acquired from icon click", {
			tabId: tab.id,
			streamIdPreview: `${streamId.slice(0, 8)}...`,
		});
		queueCaptureUntilPanelReady(streamId);
	});
};

const beginRecordingWithStreamId = (streamId: string, tabId?: number): void => {
	clearPendingCaptureTimer();
	pendingCapture = null;
	if (tabId !== undefined) {
		openSidePanelForTab(tabId);
	}
	void sendToOffscreenIfPresent({ type: "prepare-capture", target: "offscreen" });
	deliverStreamToOffscreen(streamId, true);
};

chrome.runtime.onInstalled.addListener(() => {
	configureExtension();
});

chrome.runtime.onStartup.addListener(() => {
	configureExtension();
});

chrome.windows.onRemoved.addListener(() => {
	void chrome.windows.getAll().then((windows) => {
		if (windows.length === 0) {
			shutdownExtensionResources();
		}
	});
});

if (chrome.runtime.onSuspend) {
	chrome.runtime.onSuspend.addListener(() => {
		shutdownExtensionResources();
	});
}

chrome.action.onClicked.addListener((tab) => {
	debugLog("background", "action.onClicked", { tabId: tab.id, url: tab.url, isRecording });
	if (isRecording) {
		stopRecording();
		return;
	}

	if (tab.id !== undefined) {
		openSidePanelForTab(tab.id);
	}

	beginRecordingFromIcon(tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	debugLog("background", "onMessage", {
		type: message.type,
		senderTabId: sender.tab?.id,
		senderUrl: sender.url,
	});

	if (message.type === "extension-ping") {
		sendResponse({ ok: true, buildTag: BUILD_TAG, isRecording });
		return false;
	}

	if (message.type === "get-debug-log") {
		sendResponse({
			log: getDebugLogText(),
			state: {
				buildTag: BUILD_TAG,
				isRecording,
				pendingCapture: Boolean(pendingCapture),
				offscreenReady: Boolean(offscreenReadyPromise),
				extensionId: chrome.runtime.id,
				manifestVersion: chrome.runtime.getManifest().version,
			},
		});
		return false;
	}

	if (message.type === "open-side-panel") {
		openSidePanelForTab(sender.tab?.id ?? (message.tabId as number | undefined));
		sendResponse({ success: true });
		return false;
	}

	if (message.type === "release-capture") {
		void releaseActiveCapture().then(() => {
			sendResponse({ success: true });
		});
		return true;
	}

	if (message.type === "start-with-stream-id") {
		const streamId = message.streamId as string | undefined;
		if (!streamId) {
			sendCaptureError("No stream ID received. Please try again.");
			sendResponse({ success: false });
			return false;
		}

		if (isRecording) {
			stopRecording();
			sendResponse({ success: true, stopped: true });
			return false;
		}

		beginRecordingWithStreamId(streamId, sender.tab?.id);
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

	if (message.type === "side-panel-ready") {
		debugLog("background", "side-panel-ready received", {
			pendingCapture: Boolean(pendingCapture),
			isRecording,
		});
		flushPendingCapture();
		sendResponse({ ok: true, recording: isRecording, hadPendingCapture: Boolean(pendingCapture) });
		return false;
	}

	if (message.type === "recording-state") {
		const wasRecording = isRecording;
		isRecording = message.data?.recording ?? false;
		if (isRecording && !wasRecording) {
			openSidePanelForTab(sender.tab?.id);
		}
		safeRuntimeSendMessage({
			type: "recording-state",
			data: { recording: isRecording },
		});
		return false;
	}

	return false;
});

self.addEventListener("error", (event) => {
	debugError("background", "service worker error", {
		message: event.message,
		filename: event.filename,
		lineno: event.lineno,
		colno: event.colno,
	});
});

self.addEventListener("unhandledrejection", (event) => {
	debugError("background", "service worker unhandledrejection", {
		reason: event.reason instanceof Error ? event.reason.stack : String(event.reason),
	});
});

setDebugLogContext("background");
void loadPersistedDebugLog().then(() => {
	debugLog("background", "Service worker loaded", { buildTag: BUILD_TAG });
	configureExtension();
});