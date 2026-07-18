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
	hasOffscreenDocument,
	safeRuntimeSendMessage,
	sendToOffscreenIfPresent,
} from "./lib/runtimeMessaging";

const BUILD_TAG = "background-v12-capture-fix";
const RELEASE_CAPTURE_DELAY_MS = 400;
const OFFSCREEN_READY_TIMEOUT_MS = 15_000;
const CAPTURE_START_TIMEOUT_MS = 12_000;
const SILENT_MESSAGE_TYPES = new Set(["model-status", "transcript"]);

let isRecording = false;
/** True while getMediaStreamId / offscreen ensure / start-recording is in progress. */
let captureStartInFlight = false;
let captureStartWatchdog: ReturnType<typeof setTimeout> | null = null;
let offscreenReadyPromise: Promise<void> | null = null;
let offscreenListenerReady = false;
let offscreenReadyWaiters: Array<() => void> = [];
let configuredOnce = false;
let bootstrapStarted = false;

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

const setCaptureStartInFlight = (value: boolean): void => {
	captureStartInFlight = value;

	if (captureStartWatchdog !== null) {
		clearTimeout(captureStartWatchdog);
		captureStartWatchdog = null;
	}

	if (value) {
		// Never leave the mutex stuck if createDocument / stream delivery hangs.
		captureStartWatchdog = setTimeout(() => {
			if (captureStartInFlight && !isRecording) {
				debugError("background", "Capture start timed out; clearing lock");
				sendCaptureError(
					"Capture start timed out. Click Start once more (do not spam the icon).",
				);
			}
		}, CAPTURE_START_TIMEOUT_MS);
	}

	safeRuntimeSendMessage({
		type: "capture-starting",
		data: { starting: value },
	});
};

const notifyOffscreenListenerReady = (): void => {
	offscreenListenerReady = true;
	const waiters = offscreenReadyWaiters;
	offscreenReadyWaiters = [];
	for (const resolve of waiters) {
		resolve();
	}
};

const resetOffscreenListenerReady = (): void => {
	offscreenListenerReady = false;
	offscreenReadyWaiters = [];
};

const waitForOffscreenListener = (timeoutMs = OFFSCREEN_READY_TIMEOUT_MS): Promise<void> => {
	if (offscreenListenerReady) {
		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			offscreenReadyWaiters = offscreenReadyWaiters.filter((w) => w !== onReady);
			reject(new Error("Offscreen document did not become ready in time"));
		}, timeoutMs);

		const onReady = () => {
			clearTimeout(timer);
			resolve();
		};
		offscreenReadyWaiters.push(onReady);
	});
};

const sendCaptureError = (error: string) => {
	debugError("background", "capture error", error);
	isRecording = false;
	setCaptureStartInFlight(false);
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
	resetOffscreenListenerReady();
	const existingContexts = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
	});
	if (existingContexts.length === 0) return;
	try {
		await chrome.offscreen.closeDocument();
	} catch (err) {
		debugWarn("background", "closeDocument failed", err);
	}
};

/**
 * Stop tab capture / recorder, but KEEP the offscreen document alive.
 * Closing + recreating offscreen is slow and can hang Chrome's createDocument.
 */
const releaseActiveCapture = async (): Promise<void> => {
	debugLog("background", "releaseActiveCapture start");
	isRecording = false;
	setCaptureStartInFlight(false);
	await sendToOffscreenIfPresent({ type: "stop-recording", target: "offscreen" });
	await sendToOffscreenIfPresent({ type: "prepare-capture", target: "offscreen" });
	await new Promise((resolve) => setTimeout(resolve, RELEASE_CAPTURE_DELAY_MS));
	safeRuntimeSendMessage({
		type: "recording-state",
		data: { recording: false },
	});
	debugLog("background", "releaseActiveCapture done (offscreen kept warm)");
};

const stopRecording = (): void => {
	debugLog("background", "stopRecording");
	void releaseActiveCapture();
};

const ensureOffscreenDocument = async (): Promise<void> => {
	const existingContexts = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
	});

	if (existingContexts.length > 0) {
		if (!offscreenListenerReady) {
			safeRuntimeSendMessage({ type: "ping-offscreen", target: "offscreen" });
			try {
				await waitForOffscreenListener(OFFSCREEN_READY_TIMEOUT_MS);
			} catch {
				debugWarn("background", "Existing offscreen unresponsive; recreating");
				await closeOffscreenDocument();
			}
		}
		if (offscreenListenerReady) {
			return;
		}
	}

	if (!offscreenReadyPromise) {
		resetOffscreenListenerReady();
		offscreenReadyPromise = (async () => {
			debugLog("background", "createDocument start");
			try {
				await chrome.offscreen.createDocument({
					url: "offscreen.html",
					reasons: [chrome.offscreen.Reason.USER_MEDIA],
					justification: "Recording from chrome.tabCapture API",
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// Race: another path already created it.
				if (
					message.includes("single offscreen") ||
					message.includes("Only a single") ||
					message.includes("already exists")
				) {
					debugWarn("background", "createDocument race; using existing document", message);
				} else {
					throw err;
				}
			}
			debugLog("background", "createDocument resolved; waiting for listener");
			// Document may already have posted offscreen-ready.
			if (!offscreenListenerReady) {
				safeRuntimeSendMessage({ type: "ping-offscreen", target: "offscreen" });
			}
			await waitForOffscreenListener(OFFSCREEN_READY_TIMEOUT_MS);
			debugLog("background", "offscreen listener ready");
		})().catch((err) => {
			offscreenReadyPromise = null;
			resetOffscreenListenerReady();
			throw err;
		});
	}

	await offscreenReadyPromise;
};

/**
 * Pre-create the lightweight offscreen page so the first icon click is not blocked.
 * Prewarmed offscreen is IDLE — never treat it as recording.
 */
const prewarmOffscreenDocument = (): void => {
	void ensureOffscreenDocument()
		.then(() => {
			debugLog("background", "Offscreen prewarm complete (idle, not recording)");
		})
		.catch((err) => {
			debugWarn("background", "Offscreen prewarm failed (will retry on capture)", err);
		});
};

const queryOffscreenRecording = async (): Promise<boolean> => {
	if (!(await hasOffscreenDocument())) {
		return false;
	}

	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), 1500);
		try {
			chrome.runtime.sendMessage(
				{ type: "get-offscreen-state", target: "offscreen" },
				(response?: { recording?: boolean }) => {
					clearTimeout(timer);
					void chrome.runtime.lastError;
					resolve(Boolean(response?.recording));
				},
			);
		} catch {
			clearTimeout(timer);
			resolve(false);
		}
	});
};

const configureExtension = (): void => {
	if (configuredOnce) {
		return;
	}
	configuredOnce = true;

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

	// Keep action.onClicked for capture (must not set openPanelOnActionClick: true).
	if (chrome.sidePanel?.setPanelBehavior) {
		chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }, () => {
			void chrome.runtime.lastError;
		});
	}
};

const deliverStreamToOffscreen = (streamId: string): void => {
	debugLog("background", "deliverStreamToOffscreen");
	void (async () => {
		try {
			debugLog("background", "ensureOffscreenDocument start");
			await ensureOffscreenDocument();
			debugLog("background", "ensureOffscreenDocument done", {
				offscreenListenerReady,
			});
			const settings = await loadTranscriptionSettings();
			// Mark recording only after offscreen is ready to receive the stream.
			isRecording = true;
			setCaptureStartInFlight(false);
			safeRuntimeSendMessage({
				type: "recording-state",
				data: { recording: true },
			});
			safeRuntimeSendMessage({
				type: "start-recording",
				target: "offscreen",
				streamId,
				settings,
			});
		} catch (err) {
			debugError("background", "deliverStreamToOffscreen failed", err);
			sendCaptureError(
				"Failed to start capture document. Wait a second and try again, or reload the extension.",
			);
		}
	})();
};

const handleCaptureFailure = (detail: string, tabId?: number): void => {
	debugError("background", "getMediaStreamId failed", { tabId, detail });
	setCaptureStartInFlight(false);

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
					setCaptureStartInFlight(true);
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

const tryBeginCapture = (source: string): boolean => {
	if (isRecording) {
		return false;
	}
	if (captureStartInFlight) {
		debugWarn("background", "Capture start already in flight; ignoring", { source });
		return false;
	}
	setCaptureStartInFlight(true);
	return true;
};

/**
 * Icon click: getMediaStreamId in the same turn as the user gesture.
 * Panel is UI only — do not wait for side-panel-ready.
 */
const beginRecordingFromIcon = (tab: chrome.tabs.Tab): void => {
	if (tab.id === undefined) {
		setCaptureStartInFlight(false);
		return;
	}

	if (!isCapturableUrl(tab.url)) {
		setCaptureStartInFlight(false);
		openSidePanelForTab(tab.id);
		sendCaptureError(
			`Cannot capture this page (${tab.url ?? "unknown"}). Open a normal website tab and click the extension icon there.`,
		);
		return;
	}

	requestMediaStreamId(tab.id, (streamId) => {
		debugLog("background", "Stream ID acquired from icon click", {
			tabId: tab.id,
			streamIdPreview: `${streamId.slice(0, 8)}...`,
		});
		deliverStreamToOffscreen(streamId);
	});
};

const beginRecordingFromTabId = (tabId: number, tabUrl?: string): void => {
	const startWithTab = (url: string | undefined) => {
		if (!isCapturableUrl(url)) {
			setCaptureStartInFlight(false);
			sendCaptureError(
				`Cannot capture this page (${url ?? "unknown"}). Open a normal website tab and try again.`,
			);
			return;
		}
		openSidePanelForTab(tabId);
		requestMediaStreamId(tabId, (streamId) => {
			debugLog("background", "Stream ID acquired from panel Start", {
				tabId,
				streamIdPreview: `${streamId.slice(0, 8)}...`,
			});
			deliverStreamToOffscreen(streamId);
		});
	};

	if (!isCapturableUrl(tabUrl)) {
		chrome.tabs.get(tabId, (tab) => {
			if (chrome.runtime.lastError || !tab) {
				setCaptureStartInFlight(false);
				sendCaptureError(
					chrome.runtime.lastError?.message ??
						"Could not read the active tab. Switch to the tab with audio and try again.",
				);
				return;
			}
			startWithTab(tab.url);
		});
		return;
	}

	startWithTab(tabUrl);
};

const beginRecordingWithStreamId = (streamId: string, tabId?: number): void => {
	if (tabId !== undefined) {
		openSidePanelForTab(tabId);
	}
	void sendToOffscreenIfPresent({ type: "prepare-capture", target: "offscreen" });
	deliverStreamToOffscreen(streamId);
};

/**
 * After SW start: never assume recording just because offscreen exists (prewarm is idle).
 */
const reconcileAfterServiceWorkerStart = async (): Promise<void> => {
	try {
		// Safe defaults until offscreen reports real recording.
		isRecording = false;
		captureStartInFlight = false;

		const hasOffscreen = await hasOffscreenDocument();
		if (!hasOffscreen) {
			resetOffscreenListenerReady();
			prewarmOffscreenDocument();
			return;
		}

		// Re-sync listener with existing (possibly prewarmed) document.
		safeRuntimeSendMessage({ type: "ping-offscreen", target: "offscreen" });
		try {
			await waitForOffscreenListener(3000);
			const actuallyRecording = await queryOffscreenRecording();
			isRecording = actuallyRecording;
			debugLog("background", "Reconciled offscreen after SW start", {
				isRecording: actuallyRecording,
				note: actuallyRecording
					? "offscreen reports active recording"
					: "offscreen idle (prewarm or stopped)",
			});
			if (actuallyRecording) {
				safeRuntimeSendMessage({
					type: "recording-state",
					data: { recording: true },
				});
			}
		} catch {
			debugWarn("background", "Unresponsive offscreen after SW start; recreating");
			await closeOffscreenDocument();
			isRecording = false;
			prewarmOffscreenDocument();
		}
	} catch (err) {
		debugError("background", "reconcileAfterServiceWorkerStart failed", err);
		isRecording = false;
		captureStartInFlight = false;
	}
};

const bootstrapServiceWorker = (): void => {
	if (bootstrapStarted) {
		return;
	}
	bootstrapStarted = true;

	configureExtension();
	void loadPersistedDebugLog().then(() => {
		debugLog("background", "Service worker loaded", { buildTag: BUILD_TAG });
		void reconcileAfterServiceWorkerStart();
	});
};

// Listeners must be registered synchronously (MV3).
chrome.runtime.onInstalled.addListener(() => {
	configuredOnce = false;
	bootstrapStarted = false;
	bootstrapServiceWorker();
});

chrome.runtime.onStartup.addListener(() => {
	configuredOnce = false;
	bootstrapStarted = false;
	bootstrapServiceWorker();
});

chrome.windows.onRemoved.addListener(() => {
	void chrome.windows.getAll().then((windows) => {
		if (windows.length === 0) {
			// Last window closed — free capture, keep code simple.
			void releaseActiveCapture();
		}
	});
});

if (chrome.runtime.onSuspend) {
	chrome.runtime.onSuspend.addListener(() => {
		// SW may sleep; do not destroy offscreen. Clear start lock only.
		if (captureStartWatchdog !== null) {
			clearTimeout(captureStartWatchdog);
			captureStartWatchdog = null;
		}
		captureStartInFlight = false;
	});
}

chrome.action.onClicked.addListener((tab) => {
	debugLog("background", "action.onClicked", {
		tabId: tab.id,
		url: tab.url,
		isRecording,
		captureStartInFlight,
	});

	if (isRecording) {
		stopRecording();
		return;
	}

	if (tab.id !== undefined) {
		openSidePanelForTab(tab.id);
	}

	if (!tryBeginCapture("action.onClicked")) {
		return;
	}

	beginRecordingFromIcon(tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	const messageType = typeof message?.type === "string" ? message.type : "unknown";

	if (!SILENT_MESSAGE_TYPES.has(messageType)) {
		debugLog("background", "onMessage", {
			type: messageType,
			senderTabId: sender.tab?.id,
			senderUrl: sender.url,
		});
	}

	if (message.type === "extension-ping") {
		sendResponse({
			ok: true,
			buildTag: BUILD_TAG,
			isRecording,
			captureStartInFlight,
		});
		return false;
	}

	if (message.type === "offscreen-ready") {
		debugLog("background", "offscreen-ready received");
		notifyOffscreenListenerReady();
		sendResponse({ ok: true });
		return false;
	}

	if (message.type === "get-debug-log") {
		sendResponse({
			log: getDebugLogText(),
			state: {
				buildTag: BUILD_TAG,
				isRecording,
				pendingCapture: false,
				captureStartInFlight,
				offscreenReady: offscreenListenerReady || Boolean(offscreenReadyPromise),
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

	if (message.type === "start-transcription") {
		const tabId = message.tabId as number | undefined;
		if (typeof tabId !== "number") {
			sendCaptureError("Could not detect the active tab. Switch to the tab with audio and try again.");
			sendResponse({ success: false });
			return false;
		}

		if (isRecording) {
			stopRecording();
			sendResponse({ success: true, stopped: true });
			return false;
		}

		if (!tryBeginCapture("start-transcription")) {
			sendResponse({ success: false, reason: "start-in-flight" });
			return false;
		}

		beginRecordingFromTabId(tabId, message.tabUrl as string | undefined);
		sendResponse({ success: true });
		return false;
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

		if (!tryBeginCapture("start-with-stream-id")) {
			sendResponse({ success: false, reason: "start-in-flight" });
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
		sendResponse({
			recording: isRecording,
			starting: captureStartInFlight,
		});
		return false;
	}

	if (message.type === "side-panel-ready") {
		sendResponse({
			ok: true,
			recording: isRecording,
			starting: captureStartInFlight,
			hadPendingCapture: false,
		});
		return false;
	}

	if (message.type === "recording-state") {
		const wasRecording = isRecording;
		isRecording = message.data?.recording ?? false;
		if (isRecording) {
			setCaptureStartInFlight(false);
		}
		if (isRecording && !wasRecording && sender.tab?.id !== undefined) {
			openSidePanelForTab(sender.tab.id);
		}
		if (sender.url?.includes("offscreen.html")) {
			safeRuntimeSendMessage({
				type: "recording-state",
				data: { recording: isRecording },
			});
		}
		return false;
	}

	if (message.type === "capture-error") {
		isRecording = false;
		setCaptureStartInFlight(false);
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
bootstrapServiceWorker();
