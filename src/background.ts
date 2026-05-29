let pendingTabId: number | undefined;
let isRecording = false;

const isCapturableUrl = (url: string | undefined): boolean => {
	if (!url) return false;
	const blockedPrefixes = ["chrome://", "chrome-extension://", "about:", "edge://", "brave://"];
	return !blockedPrefixes.some(prefix => url.startsWith(prefix));
};

const sendCaptureError = (error: string) => {
	chrome.runtime.sendMessage({
		type: "capture-error",
		data: { error }
	});
};

const sendStartRecording = (tabId: number) => {
	chrome.tabs.get(tabId, (tab) => {
		if (!tab || !isCapturableUrl(tab.url)) {
			console.error("Cannot capture this page (Chrome internal or restricted page)");
			sendCaptureError("Невозможно захватить эту вкладку. Chrome не разрешает захватывать внутренние страницы (chrome://, about: и т.д.). Откройте обычный сайт (например, YouTube, статью или видео) и попробуйте снова.");
			return;
		}

		chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
			if (chrome.runtime.lastError || !streamId) {
				console.error("service-worker: Failed to get stream ID", chrome.runtime.lastError);
				sendCaptureError("Не удалось получить доступ к аудио вкладки. Убедитесь, что у расширения есть разрешение и вы находитесь на обычном сайте.");
				return;
			}
			console.debug("Stream ID:", streamId);
			chrome.runtime.sendMessage({
				type: "start-recording",
				target: "offscreen",
				streamId,
			});
		});
	});
};

const startRecording = async (tabId: number): Promise<void> => {
	const existingContexts = await chrome.runtime.getContexts({});
	const offscreenDocument = existingContexts.find(
		(c) => c.contextType === "OFFSCREEN_DOCUMENT",
	);

	if (!offscreenDocument) {
		try {
			await chrome.offscreen.createDocument({
				url: "offscreen.html",
				reasons: [chrome.offscreen.Reason.USER_MEDIA],
				justification: "Recording from chrome.tabCapture API",
			});
			pendingTabId = tabId;
		} catch (err) {
			console.error("Failed to create offscreen document:", err);
			pendingTabId = undefined;
			sendCaptureError("Не удалось создать offscreen документ. Попробуйте перезагрузить расширение.");
			throw err;
		}
	} else {
		sendStartRecording(tabId);
	}
};

chrome.action.onClicked.addListener(async (tab) => {
	if (tab.id === undefined) {
		console.debug("Tab ID is undefined");
		return;
	}
	await startRecording(tab.id);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.type === "start-transcription") {
		chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
			try {
				const tab = tabs[0];
				if (tab?.id) {
					await startRecording(tab.id);
					sendResponse({ success: true });
				} else {
					sendCaptureError("Нет активной вкладки");
					sendResponse({ success: false, error: "No active tab" });
				}
			} catch (err) {
				console.error("Failed to start transcription:", err);
				sendCaptureError(String(err));
				sendResponse({ success: false, error: String(err) });
			}
		});
		return true;
	}

	if (message.type === "stop-transcription") {
		chrome.runtime.sendMessage({ type: "stop-recording", target: "offscreen" });
		sendResponse({ success: true });
		return false;
	}

	if (message.type === "get-recording-state") {
		sendResponse({ recording: isRecording });
		return false;
	}

	if (message.type === "recording-state") {
		isRecording = message.data?.recording ?? false;
		chrome.runtime.sendMessage({ type: "recording-state", data: { recording: isRecording } });
		return false;
	}

	if (message.type === "offscreen-ready") {
		if (pendingTabId === undefined) return false;
		const tabId = pendingTabId;
		pendingTabId = undefined;
		sendStartRecording(tabId);
		return false;
	}

	return false;
});
