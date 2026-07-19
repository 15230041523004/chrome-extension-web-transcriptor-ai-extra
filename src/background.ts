import {
	DEFAULT_TRANSCRIPTION_SETTINGS,
	loadTranscriptionSettings,
} from "./jotai/transcriptionSettings";
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
} from "./lib/runtimeMessaging";

type OffscreenStopAck = {
	ok?: boolean;
	captureId?: string | null;
	generation?: number;
	pendingSetupCount?: number;
	pendingMediaRequestCount?: number;
	pendingTabMediaRequestCount?: number;
	liveTracksEnded?: boolean;
	wasRecording?: boolean;
	ignoredStaleRequest?: boolean;
};

type OffscreenStartAck = {
	accepted?: boolean;
	captureId?: string;
	reason?: string;
	pendingMediaRequestCount?: number;
	pendingTabMediaRequestCount?: number;
};

type OffscreenState = {
	recording: boolean;
	captureId: string | null;
	pendingSetupCount: number;
	pendingMediaRequestCount: number;
	pendingTabMediaRequestCount: number;
};

type ReleaseBarrierResult = {
	released: boolean;
	blocking: chrome.tabCapture.CaptureInfo[];
};

type CaptureRecoveryState = {
	captureId: string | null;
	tabId: number | null;
	blocking: chrome.tabCapture.CaptureInfo[];
	offscreenKept: boolean;
	reason: string;
	enteredAt: number;
};

type OffscreenReadyWaiter = {
	resolve: () => void;
	reject: (error: Error) => void;
};

const BUILD_TAG = "background-v18-hung-capture-recovery";
const OFFSCREEN_STOP_ACK_TIMEOUT_MS = 1000;
const OFFSCREEN_START_ACK_TIMEOUT_MS = 1000;
const OFFSCREEN_API_TIMEOUT_MS = 5000;
const OFFSCREEN_CONTEXT_CLOSE_TIMEOUT_MS = 5000;
const CAPTURE_RELEASE_STATUS_TIMEOUT_MS = 1800;
const CAPTURE_PENDING_MEDIA_RELEASE_TIMEOUT_MS = 10_000;
const CAPTURE_FORCE_RELEASE_STATUS_TIMEOUT_MS = 10_000;
const CAPTURE_RELEASE_POLL_MS = 75;
const CAPTURE_RECOVERY_POLL_MS = 500;
const CAPTURE_RECOVERY_AUTOMATIC_PROBES = 20;
const SETTINGS_START_WAIT_MS = 500;
const OFFSCREEN_READY_TIMEOUT_MS = 15_000;
const CAPTURE_START_TIMEOUT_MS = 12_000;
const SILENT_MESSAGE_TYPES = new Set([
	"model-status",
	"transcript",
	"offscreen-capture-lifecycle",
]);

let isRecording = false;
/** True while offscreen/settings preparation, stream-ID delivery, or getUserMedia is in progress. */
let captureStartInFlight = false;
let captureStartWatchdog: ReturnType<typeof setTimeout> | null = null;
let activeCaptureId: string | null = null;
let activeCaptureTabId: number | null = null;
let captureAttemptSequence = 0;
let releaseInFlight: Promise<void> | null = null;
let releaseForceRequested = false;
let releaseTargetTabId: number | null = null;
let captureRecovery: CaptureRecoveryState | null = null;
let captureRecoveryProbeTimer: ReturnType<typeof setTimeout> | null = null;
let captureRecoveryProbeCount = 0;
let recoveryProbeInFlight: Promise<void> | null = null;
let offscreenReadyPromise: Promise<void> | null = null;
let offscreenClosePromise: Promise<void> | null = null;
let offscreenLifecycleEpoch = 0;
let offscreenListenerReady = false;
let offscreenReadyWaiters: OffscreenReadyWaiter[] = [];
let configuredOnce = false;
let bootstrapStarted = false;
let cachedTranscriptionSettings = DEFAULT_TRANSCRIPTION_SETTINGS;
let settingsRefreshPromise: Promise<void> | null = null;

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

const formatChromeError = (
	error: chrome.runtime.LastError | undefined,
): string => {
	if (!error) return "unknown error";
	return error.message || String(error);
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = <T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> =>
	new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback();
		};
		const timer = setTimeout(
			() => finish(() => reject(new Error(message))),
			timeoutMs,
		);
		promise.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});

const hasOffscreenDocumentWithTimeout = (): Promise<boolean> =>
	withTimeout(
		hasOffscreenDocument(),
		OFFSCREEN_API_TIMEOUT_MS,
		"Timed out while checking for an offscreen document",
	);

const nextCaptureId = (): string => {
	captureAttemptSequence += 1;
	return [
		Date.now().toString(36),
		captureAttemptSequence.toString(36),
		crypto.randomUUID().slice(0, 8),
	].join("-");
};

const isCurrentCaptureAttempt = (captureId: string): boolean =>
	activeCaptureId === captureId &&
	captureStartInFlight &&
	!releaseInFlight &&
	!captureRecovery;

const sendMessageForResponse = <T>(
	message: unknown,
	timeoutMs: number,
): Promise<T | null> =>
	new Promise((resolve) => {
		let settled = false;
		const finish = (value: T | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);

		try {
			chrome.runtime.sendMessage(message, (response?: T) => {
				if (chrome.runtime.lastError) {
					finish(null);
					return;
				}
				finish(response ?? null);
			});
		} catch {
			finish(null);
		}
	});

const setCaptureStartInFlight = (
	value: boolean,
	captureId: string | null = activeCaptureId,
): void => {
	captureStartInFlight = value;

	if (captureStartWatchdog !== null) {
		clearTimeout(captureStartWatchdog);
		captureStartWatchdog = null;
	}

	if (value && captureId) {
		const watchdogCaptureId = captureId;
		captureStartWatchdog = setTimeout(() => {
			if (
				captureStartInFlight &&
				!isRecording &&
				activeCaptureId === watchdogCaptureId
			) {
				debugError("background", "Capture start timed out; forcing release", {
					captureId: watchdogCaptureId,
					activeCaptureTabId,
				});
				const targetTabId = activeCaptureTabId;
				void releaseActiveCapture({
					forceCloseOffscreen: true,
					targetTabId,
					reason: "capture-start-timeout",
				});
				sendCaptureError(
					"Capture start timed out. The stale capture is being released; click the extension icon again in a moment.",
					watchdogCaptureId,
					false,
				);
			}
		}, CAPTURE_START_TIMEOUT_MS);
	}

	safeRuntimeSendMessage({
		type: "capture-starting",
		data: { starting: value, captureId },
	});
};

const sendCaptureError = (
	error: string,
	captureId: string | null = activeCaptureId,
	clearAttempt = true,
): void => {
	if (captureId && activeCaptureId && captureId !== activeCaptureId) {
		debugWarn("background", "Ignoring stale capture error", {
			captureId,
			activeCaptureId,
			error,
		});
		return;
	}

	debugError("background", "capture error", { error, captureId });
	isRecording = false;
	setCaptureStartInFlight(false, captureId);
	safeRuntimeSendMessage({
		type: "capture-error",
		data: { error, captureId },
	});
	safeRuntimeSendMessage({
		type: "recording-state",
		data: { recording: false, captureId },
	});

	if (clearAttempt && (!captureId || activeCaptureId === captureId)) {
		activeCaptureId = null;
		activeCaptureTabId = null;
	}
};

const sendReleaseInProgressError = (): void => {
	safeRuntimeSendMessage({
		type: "capture-error",
		data: {
			error:
				"The previous capture is still being released. Click the extension icon again in a moment.",
			captureId: activeCaptureId,
		},
	});
};

const notifyOffscreenListenerReady = (): void => {
	if (offscreenClosePromise) {
		debugWarn("background", "Ignoring offscreen-ready while closing");
		return;
	}
	offscreenListenerReady = true;
	const waiters = offscreenReadyWaiters;
	offscreenReadyWaiters = [];
	for (const waiter of waiters) {
		waiter.resolve();
	}
};

const resetOffscreenListenerReady = (
	reason = "Offscreen lifecycle was reset",
): void => {
	offscreenListenerReady = false;
	const waiters = offscreenReadyWaiters;
	offscreenReadyWaiters = [];
	for (const waiter of waiters) {
		waiter.reject(new Error(reason));
	}
};

const waitForOffscreenListener = (
	timeoutMs = OFFSCREEN_READY_TIMEOUT_MS,
): Promise<void> => {
	if (offscreenListenerReady) {
		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			offscreenReadyWaiters = offscreenReadyWaiters.filter(
				(waiter) => waiter.resolve !== onReady,
			);
			reject(new Error("Offscreen document did not become ready in time"));
		}, timeoutMs);

		const onReady = () => {
			clearTimeout(timer);
			resolve();
		};
		offscreenReadyWaiters.push({ resolve: onReady, reject });
	});
};

/**
 * Open side panel — MUST run in the same turn as a user gesture (action.onClicked).
 * Do not call this from async timeouts or capture-error handlers.
 */
const openSidePanelForTab = (tabId?: number): void => {
	debugLog("background", "openSidePanelForTab called", { tabId });
	if (tabId === undefined) {
		debugWarn("background", "Cannot open side panel without a tab id");
		return;
	}
	if (!chrome.sidePanel?.open) {
		debugWarn("background", "chrome.sidePanel.open unavailable");
		return;
	}

	// Keep this call directly in the action/user-gesture turn. The default path
	// is configured once during bootstrap; changing options here can invalidate
	// a restored panel or consume the gesture before open().
	chrome.sidePanel.open({ tabId }, () => {
		if (chrome.runtime.lastError) {
			debugWarn(
				"background",
				"sidePanel.open failed",
				chrome.runtime.lastError.message,
			);
			return;
		}
		debugLog("background", "sidePanel.open success", { tabId });
	});
};

const waitForOffscreenContextGone = async (
	timeoutMs = OFFSCREEN_CONTEXT_CLOSE_TIMEOUT_MS,
): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	do {
		const contexts = await withTimeout(
			chrome.runtime.getContexts({
				contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
			}),
			Math.min(1000, timeoutMs),
			"Timed out while waiting for the offscreen context to close",
		);
		if (contexts.length === 0) return true;
		await sleep(50);
	} while (Date.now() < deadline);
	return false;
};

const closeOffscreenDocument = (): Promise<void> => {
	if (offscreenClosePromise) return offscreenClosePromise;
	offscreenLifecycleEpoch += 1;
	offscreenReadyPromise = null;
	resetOffscreenListenerReady("Offscreen document is closing");

	const closeTask = (async () => {
		const existingContexts = await withTimeout(
			chrome.runtime.getContexts({
				contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
			}),
			OFFSCREEN_API_TIMEOUT_MS,
			"Timed out while checking the offscreen document",
		);
		if (existingContexts.length === 0) return;
		try {
			await withTimeout(
				chrome.offscreen.closeDocument(),
				OFFSCREEN_API_TIMEOUT_MS,
				"Timed out while closing the offscreen document",
			);
		} catch (err) {
			debugWarn("background", "closeDocument failed", err);
		}
		if (!(await waitForOffscreenContextGone())) {
			throw new Error("Offscreen context remained after closeDocument");
		}
	})().finally(() => {
		if (offscreenClosePromise === closeTask) {
			offscreenClosePromise = null;
		}
	});
	offscreenClosePromise = closeTask;
	return closeTask;
};

const getBlockingCaptureInfo = async (
	targetTabId: number | null,
): Promise<chrome.tabCapture.CaptureInfo[]> => {
	const captures = await withTimeout(
		chrome.tabCapture.getCapturedTabs(),
		OFFSCREEN_API_TIMEOUT_MS,
		"Timed out while reading tab capture status",
	);
	return captures.filter(
		(info) =>
			(targetTabId === null || info.tabId === targetTabId) &&
			(info.status === "pending" || info.status === "active"),
	);
};

const waitForCaptureRelease = async (
	targetTabId: number | null,
	timeoutMs = CAPTURE_RELEASE_STATUS_TIMEOUT_MS,
): Promise<ReleaseBarrierResult> => {
	const deadline = Date.now() + timeoutMs;
	let blocking: chrome.tabCapture.CaptureInfo[] = [];

	do {
		try {
			blocking = await getBlockingCaptureInfo(targetTabId);
			if (blocking.length === 0) {
				return { released: true, blocking: [] };
			}
		} catch (err) {
			debugWarn(
				"background",
				"getCapturedTabs failed during release barrier",
				err,
			);
			return { released: false, blocking };
		}
		await sleep(CAPTURE_RELEASE_POLL_MS);
	} while (Date.now() < deadline);

	return { released: false, blocking };
};

const clearCaptureRecovery = (reason: string): void => {
	const previous = captureRecovery;
	if (!previous) return;
	captureRecovery = null;
	captureRecoveryProbeCount = 0;
	if (captureRecoveryProbeTimer !== null) {
		clearTimeout(captureRecoveryProbeTimer);
		captureRecoveryProbeTimer = null;
	}
	if (!previous.captureId || activeCaptureId === previous.captureId) {
		activeCaptureId = null;
		activeCaptureTabId = null;
	}
	debugLog("background", "Capture recovery cleared", {
		reason,
		previous,
	});
	safeRuntimeSendMessage({
		type: "capture-recovery-state",
		data: { recovering: false, reason },
	});
	if (!previous.offscreenKept) {
		// A status-change event can clear recovery just before releaseInFlight's
		// finally runs. Defer so the prewarm gate observes the settled release.
		setTimeout(prewarmOffscreenDocument, 0);
	}
};

const scheduleCaptureRecoveryProbe = (): void => {
	if (
		!captureRecovery ||
		captureRecoveryProbeTimer !== null ||
		captureRecoveryProbeCount >= CAPTURE_RECOVERY_AUTOMATIC_PROBES
	) {
		return;
	}
	captureRecoveryProbeTimer = setTimeout(() => {
		captureRecoveryProbeTimer = null;
		captureRecoveryProbeCount += 1;
		void probeCaptureRecovery("scheduled-probe");
	}, CAPTURE_RECOVERY_POLL_MS);
};

const probeCaptureRecovery = (reason: string): Promise<void> => {
	if (!captureRecovery) return Promise.resolve();
	if (recoveryProbeInFlight) return recoveryProbeInFlight;

	const expectedRecovery = captureRecovery;
	const probe = getBlockingCaptureInfo(expectedRecovery.tabId)
		.then(async (blocking) => {
			if (captureRecovery !== expectedRecovery) return;
			if (blocking.length === 0) {
				if (expectedRecovery.offscreenKept) {
					const offscreenState = await queryOffscreenState();
					if (captureRecovery !== expectedRecovery) return;
					if (
						!offscreenState ||
						offscreenState.pendingTabMediaRequestCount > 0
					) {
						expectedRecovery.blocking = [];
						scheduleCaptureRecoveryProbe();
						return;
					}
				}
				clearCaptureRecovery(reason);
				return;
			}
			expectedRecovery.blocking = blocking;
			scheduleCaptureRecoveryProbe();
		})
		.catch((err) => {
			debugWarn("background", "Capture recovery probe failed", {
				reason,
				err,
			});
			scheduleCaptureRecoveryProbe();
		})
		.finally(() => {
			if (recoveryProbeInFlight === probe) {
				recoveryProbeInFlight = null;
			}
		});
	recoveryProbeInFlight = probe;
	return probe;
};

const enterCaptureRecovery = (state: CaptureRecoveryState): void => {
	captureRecovery = state;
	captureRecoveryProbeCount = 0;
	debugWarn("background", "Capture recovery entered", state);
	safeRuntimeSendMessage({
		type: "capture-recovery-state",
		data: {
			recovering: true,
			captureId: state.captureId,
			tabId: state.tabId,
			reason: state.reason,
			blocking: state.blocking,
		},
	});
	scheduleCaptureRecoveryProbe();
};

const requestOffscreenStop = async (
	captureId: string | null,
	reason: string,
): Promise<{ documentPresent: boolean; ack: OffscreenStopAck | null }> => {
	try {
		if (!(await hasOffscreenDocumentWithTimeout())) {
			return { documentPresent: false, ack: null };
		}
	} catch {
		return { documentPresent: false, ack: null };
	}

	const ack = await sendMessageForResponse<OffscreenStopAck>(
		{
			type: "stop-recording",
			target: "offscreen",
			captureId,
			reason,
		},
		OFFSCREEN_STOP_ACK_TIMEOUT_MS,
	);
	return { documentPresent: true, ack };
};

const releaseActiveCapture = (options?: {
	forceCloseOffscreen?: boolean;
	targetTabId?: number | null;
	reason?: string;
}): Promise<void> => {
	if (options?.forceCloseOffscreen) {
		releaseForceRequested = true;
	}
	if (typeof options?.targetTabId === "number") {
		releaseTargetTabId = options.targetTabId;
	} else if (releaseTargetTabId === null && activeCaptureTabId !== null) {
		releaseTargetTabId = activeCaptureTabId;
	}

	if (releaseInFlight) {
		debugLog("background", "releaseActiveCapture joined existing release", {
			forceRequested: releaseForceRequested,
			targetTabId: releaseTargetTabId,
		});
		return releaseInFlight;
	}

	const releaseCaptureId = activeCaptureId;
	const targetTabId = releaseTargetTabId;
	const reason = options?.reason ?? "release-active-capture";
	isRecording = false;
	setCaptureStartInFlight(false, releaseCaptureId);
	safeRuntimeSendMessage({
		type: "recording-state",
		data: { recording: false, captureId: releaseCaptureId },
	});

	let browserReleased = false;
	let forced = false;
	let prewarmAfterRelease = false;
	let lastBlocking: chrome.tabCapture.CaptureInfo[] = [];

	const executeRelease = async (): Promise<void> => {
		debugLog("background", "releaseActiveCapture start", {
			captureId: releaseCaptureId,
			targetTabId,
			forceRequested: releaseForceRequested,
			reason,
		});

		const stopResult = await requestOffscreenStop(releaseCaptureId, reason);
		const pendingMediaRequestCount =
			stopResult.ack?.pendingMediaRequestCount ?? 0;
		const pendingTabMediaRequestCount =
			stopResult.ack?.pendingTabMediaRequestCount ?? 0;
		let shouldForce = releaseForceRequested;
		releaseForceRequested = false;

		if (stopResult.ack?.ignoredStaleRequest) {
			debugWarn("background", "Offscreen ignored stale stop request", {
				releaseCaptureId,
				offscreenCaptureId: stopResult.ack.captureId,
				pendingMediaRequestCount,
				pendingTabMediaRequestCount,
			});
			// A responsive offscreen with a pending raw media request owns the only
			// continuation that can stop a late stream. Keep it alive for recovery.
			shouldForce = pendingTabMediaRequestCount === 0;
		}
		if (stopResult.documentPresent && !stopResult.ack?.ok) {
			shouldForce = true;
		}
		if (
			stopResult.ack?.liveTracksEnded === false &&
			pendingMediaRequestCount === 0
		) {
			shouldForce = true;
		}

		let barrier: ReleaseBarrierResult = { released: false, blocking: [] };
		if (shouldForce) {
			forced = true;
			await closeOffscreenDocument();
			barrier = await waitForCaptureRelease(
				targetTabId,
				CAPTURE_FORCE_RELEASE_STATUS_TIMEOUT_MS,
			);
		} else {
			barrier = await waitForCaptureRelease(
				targetTabId,
				pendingMediaRequestCount > 0
					? CAPTURE_PENDING_MEDIA_RELEASE_TIMEOUT_MS
					: CAPTURE_RELEASE_STATUS_TIMEOUT_MS,
			);
			if (!barrier.released && pendingMediaRequestCount === 0) {
				forced = true;
				await closeOffscreenDocument();
				barrier = await waitForCaptureRelease(
					targetTabId,
					CAPTURE_FORCE_RELEASE_STATUS_TIMEOUT_MS,
				);
			}
		}

		if (releaseForceRequested && !forced) {
			releaseForceRequested = false;
			forced = true;
			await closeOffscreenDocument();
			barrier = await waitForCaptureRelease(
				targetTabId,
				CAPTURE_FORCE_RELEASE_STATUS_TIMEOUT_MS,
			);
		}

		browserReleased = barrier.released;
		lastBlocking = barrier.blocking;
		if (browserReleased) {
			if (captureRecovery) {
				clearCaptureRecovery("release-barrier");
			}
			prewarmAfterRelease = forced;
		} else {
			enterCaptureRecovery({
				captureId: releaseCaptureId,
				tabId: targetTabId,
				blocking: barrier.blocking,
				offscreenKept: !forced,
				reason,
				enteredAt: Date.now(),
			});
			debugWarn(
				"background",
				"Browser capture remains blocked; entering recovery",
				{
					targetTabId,
					blocking: barrier.blocking,
					offscreenKept: !forced,
				},
			);
		}

		debugLog("background", "releaseActiveCapture done", {
			captureId: releaseCaptureId,
			targetTabId,
			ack: stopResult.ack,
			forced,
			browserReleased,
			offscreenKept: !forced,
			recovering: Boolean(captureRecovery),
		});
	};

	const task = executeRelease()
		.catch((err) => {
			debugError("background", "releaseActiveCapture failed", {
				reason,
				err,
			});
			enterCaptureRecovery({
				captureId: releaseCaptureId,
				tabId: targetTabId,
				blocking: lastBlocking,
				offscreenKept: !forced,
				reason: [reason, "release-error"].join(":"),
				enteredAt: Date.now(),
			});
		})
		.finally(() => {
			const lateForce = releaseForceRequested;
			const lateTargetTabId = releaseTargetTabId;
			releaseInFlight = null;
			releaseForceRequested = false;
			releaseTargetTabId = null;
			if (
				browserReleased &&
				(!releaseCaptureId || activeCaptureId === releaseCaptureId)
			) {
				activeCaptureId = null;
				activeCaptureTabId = null;
			}
			if (lateForce) {
				void releaseActiveCapture({
					forceCloseOffscreen: true,
					targetTabId: lateTargetTabId,
					reason: "late-force-upgrade",
				});
			} else if (prewarmAfterRelease) {
				prewarmOffscreenDocument();
			}
		});
	releaseInFlight = task;
	return task;
};

const stopRecording = (): void => {
	debugLog("background", "stopRecording", {
		captureId: activeCaptureId,
		tabId: activeCaptureTabId,
	});
	void releaseActiveCapture({
		forceCloseOffscreen: false,
		targetTabId: activeCaptureTabId,
		reason: "intentional-stop",
	});
};

const ensureOffscreenDocument = async (): Promise<void> => {
	if (offscreenClosePromise) {
		await offscreenClosePromise;
	}

	const existingContexts = await withTimeout(
		chrome.runtime.getContexts({
			contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
		}),
		OFFSCREEN_API_TIMEOUT_MS,
		"Timed out while checking the offscreen document",
	);

	if (existingContexts.length === 0 && offscreenListenerReady) {
		// Chrome may destroy an offscreen context independently. A fulfilled
		// ready promise must not suppress creation of its replacement.
		offscreenReadyPromise = null;
		resetOffscreenListenerReady("The previous offscreen context disappeared");
	}

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
		if (offscreenListenerReady) return;
	}

	if (!offscreenReadyPromise) {
		const ensureEpoch = offscreenLifecycleEpoch;
		resetOffscreenListenerReady("A new offscreen document is being created");
		let readyTask: Promise<void>;
		readyTask = (async () => {
			debugLog("background", "createDocument start", { ensureEpoch });
			try {
				await withTimeout(
					chrome.offscreen.createDocument({
						url: "offscreen.html",
						reasons: [chrome.offscreen.Reason.USER_MEDIA],
						justification: "Recording from chrome.tabCapture API",
					}),
					OFFSCREEN_API_TIMEOUT_MS,
					"Timed out while creating the offscreen document",
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (
					message.includes("single offscreen") ||
					message.includes("Only a single") ||
					message.includes("already exists")
				) {
					debugWarn(
						"background",
						"createDocument race; using existing document",
						message,
					);
				} else {
					throw err;
				}
			}
			if (ensureEpoch !== offscreenLifecycleEpoch) {
				throw new Error("Stale offscreen create completion ignored");
			}
			debugLog("background", "createDocument resolved; waiting for listener", {
				ensureEpoch,
			});
			if (!offscreenListenerReady) {
				safeRuntimeSendMessage({ type: "ping-offscreen", target: "offscreen" });
			}
			await waitForOffscreenListener(OFFSCREEN_READY_TIMEOUT_MS);
			if (ensureEpoch !== offscreenLifecycleEpoch) {
				throw new Error("Stale offscreen listener completion ignored");
			}
			debugLog("background", "offscreen listener ready", { ensureEpoch });
		})().catch((err) => {
			if (offscreenReadyPromise === readyTask) {
				offscreenReadyPromise = null;
				resetOffscreenListenerReady("Offscreen preparation failed");
			}
			throw err;
		});
		offscreenReadyPromise = readyTask;
	}

	await offscreenReadyPromise;
};

/**
 * Pre-create the lightweight offscreen page only while the browser has no
 * pending/active tabCapture request. Recovery owns the old consumer context.
 */
const prewarmOffscreenDocument = (): void => {
	if (
		captureRecovery ||
		releaseInFlight ||
		captureStartInFlight ||
		isRecording
	) {
		debugLog("background", "Offscreen prewarm deferred", {
			recovering: Boolean(captureRecovery),
			releasing: Boolean(releaseInFlight),
			captureStartInFlight,
			isRecording,
		});
		return;
	}

	void getBlockingCaptureInfo(null)
		.then((blocking) => {
			if (
				blocking.length > 0 ||
				captureRecovery ||
				releaseInFlight ||
				captureStartInFlight ||
				isRecording
			) {
				debugWarn("background", "Offscreen prewarm blocked by capture state", {
					blocking,
				});
				return;
			}
			return ensureOffscreenDocument().then(() => true);
		})
		.then((prewarmed) => {
			if (prewarmed && !captureRecovery && !releaseInFlight) {
				debugLog(
					"background",
					"Offscreen prewarm complete (idle, not recording)",
				);
			}
		})
		.catch((err) => {
			debugWarn(
				"background",
				"Offscreen prewarm failed (will retry on capture)",
				err,
			);
		});
};

const queryOffscreenState = async (): Promise<OffscreenState | null> => {
	if (!(await hasOffscreenDocumentWithTimeout())) {
		return {
			recording: false,
			captureId: null,
			pendingSetupCount: 0,
			pendingMediaRequestCount: 0,
			pendingTabMediaRequestCount: 0,
		};
	}

	return sendMessageForResponse<OffscreenState>(
		{ type: "get-offscreen-state", target: "offscreen" },
		1500,
	);
};

const configureExtension = (): void => {
	if (configuredOnce) {
		return;
	}
	configuredOnce = true;

	// The default side-panel path comes from manifest.json. Do not mutate per-tab
	// options during startup; restored panel instances must remain attached.
	// Keep action.onClicked for capture (must not set openPanelOnActionClick: true).
	if (chrome.sidePanel?.setPanelBehavior) {
		chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }, () => {
			void chrome.runtime.lastError;
		});
	}
};

const refreshTranscriptionSettings = (): Promise<void> => {
	if (!settingsRefreshPromise) {
		settingsRefreshPromise = loadTranscriptionSettings()
			.then((settings) => {
				cachedTranscriptionSettings = settings;
				debugLog("background", "transcription settings cache refreshed");
			})
			.catch((err) => {
				debugWarn(
					"background",
					"loadTranscriptionSettings failed; using cache",
					err,
				);
			})
			.finally(() => {
				settingsRefreshPromise = null;
			});
	}
	return settingsRefreshPromise;
};

const getSettingsSnapshotForStart = async () => {
	await Promise.race([
		refreshTranscriptionSettings(),
		sleep(SETTINGS_START_WAIT_MS),
	]);
	return { ...cachedTranscriptionSettings };
};

const prepareCaptureAttempt = async (captureId: string) => {
	debugLog("background", "prepareCaptureAttempt start", { captureId });
	const blocking = await getBlockingCaptureInfo(null);
	if (blocking.length > 0) {
		const offscreenKept = await hasOffscreenDocumentWithTimeout().catch(
			() => false,
		);
		const blockingTabId = blocking[0]?.tabId ?? activeCaptureTabId;
		activeCaptureTabId = blockingTabId;
		setCaptureStartInFlight(false, captureId);
		enterCaptureRecovery({
			captureId,
			tabId: blockingTabId,
			blocking,
			offscreenKept,
			reason: "blocking-capture-before-prepare",
			enteredAt: Date.now(),
		});
		sendCaptureError(
			"Chrome is still releasing a previous tab capture. Please click the extension icon again after recovery completes.",
			captureId,
			false,
		);
		return null;
	}
	const [, settings] = await Promise.all([
		ensureOffscreenDocument(),
		getSettingsSnapshotForStart(),
	]);
	if (!isCurrentCaptureAttempt(captureId)) {
		debugWarn("background", "Capture attempt cancelled during preparation", {
			captureId,
			activeCaptureId,
		});
		return null;
	}
	debugLog("background", "prepareCaptureAttempt done", { captureId });
	return settings;
};

const deliverStreamToOffscreen = (
	streamId: string,
	captureId: string,
	settings: typeof DEFAULT_TRANSCRIPTION_SETTINGS,
): void => {
	if (!isCurrentCaptureAttempt(captureId)) return;
	debugLog("background", "Sending start-recording to offscreen", {
		captureId,
		streamIdPreview: [streamId.slice(0, 8), "..."].join(""),
	});

	// sendMessage is initiated synchronously here. Do not add awaits after acquiring streamId.
	const ackPromise = sendMessageForResponse<OffscreenStartAck>(
		{
			type: "start-recording",
			target: "offscreen",
			streamId,
			captureId,
			settings,
		},
		OFFSCREEN_START_ACK_TIMEOUT_MS,
	);

	void ackPromise.then((ack) => {
		if (!isCurrentCaptureAttempt(captureId)) return;
		if (ack?.accepted && ack.captureId === captureId) {
			debugLog("background", "Offscreen accepted capture start", { captureId });
			return;
		}

		debugWarn("background", "Offscreen did not acknowledge capture start", {
			captureId,
			ack,
		});
		void releaseActiveCapture({
			forceCloseOffscreen: ack?.reason !== "media-request-pending",
			targetTabId: activeCaptureTabId,
			reason:
				ack?.reason === "media-request-pending"
					? "start-rejected-media-pending"
					: "start-ack-missing",
		});
		sendCaptureError(
			"The capture document did not accept the stream. It is being reset; click the extension icon again in a moment.",
			captureId,
			false,
		);
	});
};

const handleCaptureFailure = (
	detail: string,
	tabId: number,
	captureId: string,
): void => {
	debugError("background", "getMediaStreamId failed", {
		tabId,
		captureId,
		detail,
	});
	if (!isCurrentCaptureAttempt(captureId)) return;

	const normalized = detail.toLowerCase();
	if (normalized.includes("active stream")) {
		void releaseActiveCapture({
			forceCloseOffscreen: false,
			targetTabId: tabId,
			reason: "active-stream-recovery",
		});
		sendCaptureError(
			"A previous capture is being released. Click the extension icon again in a moment.",
			captureId,
			false,
		);
		return;
	}

	if (
		normalized.includes("not been invoked") ||
		normalized.includes("activetab")
	) {
		sendCaptureError(
			"Click the extension icon on the tab with video. Chrome has not granted capture access for this tab.",
			captureId,
		);
		return;
	}

	sendCaptureError(
		["Chrome rejected audio capture: ", detail].join(""),
		captureId,
	);
};

const requestMediaStreamId = (
	tabId: number,
	captureId: string,
	settings: typeof DEFAULT_TRANSCRIPTION_SETTINGS,
): void => {
	if (!isCurrentCaptureAttempt(captureId)) return;
	chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
		if (!isCurrentCaptureAttempt(captureId)) {
			debugWarn(
				"background",
				"Discarding stream ID for stale capture attempt",
				{
					captureId,
				},
			);
			return;
		}

		const captureError = chrome.runtime.lastError;
		if (captureError || !streamId) {
			handleCaptureFailure(formatChromeError(captureError), tabId, captureId);
			return;
		}

		debugLog("background", "Stream ID acquired", {
			tabId,
			captureId,
			streamIdPreview: [streamId.slice(0, 8), "..."].join(""),
		});
		deliverStreamToOffscreen(streamId, captureId, settings);
	});
};

const tryBeginCapture = (source: string, tabId: number): string | null => {
	if (captureRecovery) {
		debugWarn(
			"background",
			"Capture blocked while browser recovery is active",
			{
				source,
				recovery: captureRecovery,
			},
		);
		void probeCaptureRecovery("blocked-start-click");
		sendCaptureError(
			"Chrome is still releasing the previous tab capture. Please click the extension icon again after recovery completes.",
			captureRecovery.captureId,
			false,
		);
		return null;
	}
	if (releaseInFlight) {
		debugWarn("background", "Capture blocked while release is in flight", {
			source,
		});
		sendReleaseInProgressError();
		return null;
	}
	if (isRecording || captureStartInFlight) {
		debugWarn("background", "Capture already active or starting", {
			source,
			isRecording,
			captureStartInFlight,
		});
		return null;
	}

	const captureId = nextCaptureId();
	activeCaptureId = captureId;
	activeCaptureTabId = tabId;
	setCaptureStartInFlight(true, captureId);
	return captureId;
};

const beginPreparedCapture = (tabId: number, captureId: string): void => {
	void prepareCaptureAttempt(captureId)
		.then((settings) => {
			if (!settings || !isCurrentCaptureAttempt(captureId)) return;
			requestMediaStreamId(tabId, captureId, settings);
		})
		.catch((err) => {
			if (!isCurrentCaptureAttempt(captureId)) return;
			debugError("background", "Capture preparation failed", err);
			sendCaptureError(
				"Failed to prepare the capture document. Click the extension icon again.",
				captureId,
			);
		});
};

const beginRecordingFromIcon = (
	tab: chrome.tabs.Tab,
	captureId: string,
): void => {
	if (tab.id === undefined) {
		sendCaptureError("Could not detect the active tab.", captureId);
		return;
	}
	if (!isCapturableUrl(tab.url)) {
		sendCaptureError(
			[
				"Cannot capture this page (",
				tab.url ?? "unknown",
				"). Open a normal website tab and click the extension icon there.",
			].join(""),
			captureId,
		);
		return;
	}
	beginPreparedCapture(tab.id, captureId);
};

const beginRecordingFromTabId = (
	tabId: number,
	captureId: string,
	tabUrl?: string,
): void => {
	const startWithUrl = (url: string | undefined): void => {
		if (!isCurrentCaptureAttempt(captureId)) return;
		if (!isCapturableUrl(url)) {
			sendCaptureError(
				[
					"Cannot capture this page (",
					url ?? "unknown",
					"). Open a normal website tab and try again.",
				].join(""),
				captureId,
			);
			return;
		}
		openSidePanelForTab(tabId);
		beginPreparedCapture(tabId, captureId);
	};

	if (!isCapturableUrl(tabUrl)) {
		chrome.tabs.get(tabId, (tab) => {
			if (!isCurrentCaptureAttempt(captureId)) return;
			if (chrome.runtime.lastError || !tab) {
				sendCaptureError(
					chrome.runtime.lastError?.message ??
						"Could not read the active tab. Switch to the tab with audio and try again.",
					captureId,
				);
				return;
			}
			startWithUrl(tab.url);
		});
		return;
	}

	startWithUrl(tabUrl);
};

const beginRecordingWithStreamId = (
	streamId: string,
	captureId: string,
	tabId?: number,
): void => {
	if (tabId !== undefined) {
		openSidePanelForTab(tabId);
	}
	if (!offscreenListenerReady) {
		sendCaptureError(
			"The capture document is not ready. Click the extension icon to start capture.",
			captureId,
		);
		return;
	}
	deliverStreamToOffscreen(streamId, captureId, {
		...cachedTranscriptionSettings,
	});
};

/**
 * Reconcile a pre-existing offscreen document after a service-worker restart.
 */
const reconcileAfterServiceWorkerStart = async (): Promise<void> => {
	try {
		if (captureStartInFlight || isRecording || releaseInFlight) {
			debugLog(
				"background",
				"Skip reconcile; capture lifecycle already active",
			);
			return;
		}

		const hasOffscreen = await hasOffscreenDocumentWithTimeout();
		if (captureStartInFlight || isRecording || releaseInFlight) return;
		if (!hasOffscreen) {
			resetOffscreenListenerReady();
			const blocking = await getBlockingCaptureInfo(null);
			if (blocking.length > 0) {
				const tabId = blocking[0]?.tabId ?? null;
				activeCaptureTabId = tabId;
				enterCaptureRecovery({
					captureId: activeCaptureId,
					tabId,
					blocking,
					offscreenKept: false,
					reason: "startup-browser-capture-without-offscreen",
					enteredAt: Date.now(),
				});
				return;
			}
			prewarmOffscreenDocument();
			return;
		}

		if (!offscreenListenerReady) {
			safeRuntimeSendMessage({ type: "ping-offscreen", target: "offscreen" });
			try {
				await waitForOffscreenListener(3000);
			} catch {
				if (captureStartInFlight || isRecording || releaseInFlight) return;
				debugWarn(
					"background",
					"Unresponsive offscreen after SW start; forcing cleanup",
				);
				const blocking = await getBlockingCaptureInfo(null);
				activeCaptureTabId = blocking[0]?.tabId ?? null;
				void releaseActiveCapture({
					forceCloseOffscreen: true,
					targetTabId: activeCaptureTabId,
					reason: "startup-unresponsive-offscreen",
				});
				return;
			}
		}

		if (captureStartInFlight || isRecording || releaseInFlight) return;
		const state = await queryOffscreenState();
		if (captureStartInFlight || isRecording || releaseInFlight) return;
		if (!state) {
			debugWarn(
				"background",
				"Offscreen state query timed out; forcing cleanup",
			);
			const blocking = await getBlockingCaptureInfo(null);
			activeCaptureTabId = blocking[0]?.tabId ?? null;
			void releaseActiveCapture({
				forceCloseOffscreen: true,
				targetTabId: activeCaptureTabId,
				reason: "startup-offscreen-state-timeout",
			});
			return;
		}

		const blocking = await getBlockingCaptureInfo(null);
		activeCaptureId = state.captureId;
		activeCaptureTabId = blocking[0]?.tabId ?? null;
		if (state.pendingSetupCount > 0 || state.pendingTabMediaRequestCount > 0) {
			debugWarn(
				"background",
				"Pending capture setup found after SW restart; recovering",
				state,
			);
			void releaseActiveCapture({
				forceCloseOffscreen: false,
				targetTabId: activeCaptureTabId,
				reason: "startup-pending-media-request",
			});
			return;
		}

		isRecording = state.recording;
		debugLog("background", "Reconciled offscreen after SW start", state);
		if (state.recording) {
			safeRuntimeSendMessage({
				type: "recording-state",
				data: { recording: true, captureId: state.captureId },
			});
		} else {
			activeCaptureId = null;
			activeCaptureTabId = null;
		}
	} catch (err) {
		debugError("background", "reconcileAfterServiceWorkerStart failed", err);
		if (!captureStartInFlight && !isRecording) {
			isRecording = false;
		}
	}
};

const bootstrapServiceWorker = (): void => {
	if (bootstrapStarted) {
		return;
	}
	bootstrapStarted = true;

	// Side panel must be enabled before any icon click (synchronous).
	configureExtension();
	void refreshTranscriptionSettings();

	// Debug log load is best-effort and must not gate capture or reconcile safety.
	void loadPersistedDebugLog()
		.catch(() => {
			// ignore
		})
		.finally(() => {
			debugLog("background", "Service worker loaded", { buildTag: BUILD_TAG });
			// Defer reconcile slightly so an icon-click that woke the SW wins the race.
			setTimeout(() => {
				void reconcileAfterServiceWorkerStart();
			}, 50);
		});
};

// Listeners must be registered synchronously (MV3).
chrome.runtime.onInstalled.addListener(() => {
	bootstrapServiceWorker();
});

chrome.runtime.onStartup.addListener(() => {
	bootstrapServiceWorker();
});

chrome.tabCapture.onStatusChanged.addListener((info) => {
	debugLog("background", "tabCapture status changed", info);
	if (
		captureRecovery &&
		(captureRecovery.tabId === null || captureRecovery.tabId === info.tabId) &&
		(info.status === "stopped" || info.status === "error")
	) {
		void probeCaptureRecovery("tab-capture-status-changed");
	}
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
		releaseInFlight: Boolean(releaseInFlight),
		recovering: Boolean(captureRecovery),
		activeCaptureId,
	});

	if (tab.id !== undefined) {
		openSidePanelForTab(tab.id);
	}
	if (isRecording || captureStartInFlight) {
		stopRecording();
		return;
	}
	if (tab.id === undefined) return;

	const captureId = tryBeginCapture("action.onClicked", tab.id);
	if (!captureId) return;
	beginRecordingFromIcon(tab, captureId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	const messageType =
		typeof message?.type === "string" ? message.type : "unknown";

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
			releaseInFlight: Boolean(releaseInFlight),
			recovering: Boolean(captureRecovery),
			activeCaptureId,
		});
		return false;
	}

	if (message.type === "offscreen-ready") {
		debugLog("background", "offscreen-ready received");
		notifyOffscreenListenerReady();
		sendResponse({ ok: true });
		return false;
	}

	if (message.type === "offscreen-capture-lifecycle") {
		const lifecycleEvent = String(message.data?.event ?? "capture lifecycle");
		debugLog(
			"background",
			["offscreen ", lifecycleEvent].join(""),
			message.data,
		);
		if (captureRecovery && lifecycleEvent === "media-request-settled") {
			void probeCaptureRecovery("offscreen-media-request-settled");
		}
		return false;
	}

	if (message.type === "get-debug-log") {
		sendResponse({
			log: getDebugLogText(),
			state: {
				buildTag: BUILD_TAG,
				isRecording,
				pendingCapture: captureStartInFlight,
				captureStartInFlight,
				releaseInFlight: Boolean(releaseInFlight),
				recovering: Boolean(captureRecovery),
				recovery: captureRecovery,
				activeCaptureId,
				activeCaptureTabId,
				offscreenReady:
					offscreenListenerReady || Boolean(offscreenReadyPromise),
				extensionId: chrome.runtime.id,
				manifestVersion: chrome.runtime.getManifest().version,
			},
		});
		return false;
	}

	if (message.type === "open-side-panel") {
		openSidePanelForTab(
			sender.tab?.id ?? (message.tabId as number | undefined),
		);
		sendResponse({ success: true });
		return false;
	}

	if (message.type === "release-capture") {
		void releaseActiveCapture({
			targetTabId: activeCaptureTabId,
			reason: "release-capture-message",
		}).then(() => {
			sendResponse({ success: true });
		});
		return true;
	}

	if (message.type === "start-transcription") {
		const tabId = message.tabId as number | undefined;
		if (typeof tabId !== "number") {
			sendCaptureError(
				"Could not detect the active tab. Switch to the tab with audio and try again.",
			);
			sendResponse({ success: false });
			return false;
		}

		if (isRecording || captureStartInFlight) {
			stopRecording();
			sendResponse({ success: true, stopped: true });
			return false;
		}

		const captureId = tryBeginCapture("start-transcription", tabId);
		if (!captureId) {
			sendResponse({ success: false, reason: "capture-unavailable" });
			return false;
		}

		beginRecordingFromTabId(
			tabId,
			captureId,
			message.tabUrl as string | undefined,
		);
		sendResponse({ success: true, captureId });
		return false;
	}

	if (message.type === "start-with-stream-id") {
		const streamId = message.streamId as string | undefined;
		if (!streamId) {
			sendCaptureError("No stream ID received. Please try again.");
			sendResponse({ success: false });
			return false;
		}
		if (isRecording || captureStartInFlight) {
			stopRecording();
			sendResponse({ success: true, stopped: true });
			return false;
		}

		const tabId = sender.tab?.id;
		if (typeof tabId !== "number") {
			sendCaptureError("Could not detect the source tab for this stream ID.");
			sendResponse({ success: false });
			return false;
		}
		const captureId = tryBeginCapture("start-with-stream-id", tabId);
		if (!captureId) {
			sendResponse({ success: false, reason: "capture-unavailable" });
			return false;
		}

		beginRecordingWithStreamId(streamId, captureId, tabId);
		sendResponse({ success: true, captureId });
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
			stopping: Boolean(releaseInFlight) || Boolean(captureRecovery),
			recovering: Boolean(captureRecovery),
			captureId: activeCaptureId,
		});
		return false;
	}

	if (message.type === "side-panel-ready") {
		debugLog("background", "side-panel-ready received", {
			isRecording,
			captureStartInFlight,
			releaseInFlight: Boolean(releaseInFlight),
			recovering: Boolean(captureRecovery),
		});
		sendResponse({
			ok: true,
			recording: isRecording,
			starting: captureStartInFlight,
			stopping: Boolean(releaseInFlight) || Boolean(captureRecovery),
			recovering: Boolean(captureRecovery),
			captureId: activeCaptureId,
			hadPendingCapture: false,
		});
		return false;
	}

	if (message.type === "recording-state") {
		const messageCaptureId =
			typeof message.data?.captureId === "string"
				? message.data.captureId
				: null;
		if (
			messageCaptureId &&
			activeCaptureId &&
			messageCaptureId !== activeCaptureId
		) {
			debugWarn("background", "Ignoring stale recording-state", {
				messageCaptureId,
				activeCaptureId,
			});
			return false;
		}

		const wasRecording = isRecording;
		const nextRecording = Boolean(message.data?.recording);
		if (nextRecording && messageCaptureId && !activeCaptureId) {
			activeCaptureId = messageCaptureId;
		}
		isRecording = nextRecording;
		if (nextRecording) {
			setCaptureStartInFlight(false, messageCaptureId);
		} else if (!releaseInFlight && !captureRecovery) {
			setCaptureStartInFlight(false, messageCaptureId);
			activeCaptureId = null;
			activeCaptureTabId = null;
		}
		if (nextRecording && !wasRecording && sender.tab?.id !== undefined) {
			openSidePanelForTab(sender.tab.id);
		}
		if (sender.url?.includes("offscreen.html")) {
			safeRuntimeSendMessage({
				type: "recording-state",
				data: { recording: nextRecording, captureId: messageCaptureId },
			});
		}
		return false;
	}

	if (message.type === "capture-error") {
		const messageCaptureId =
			typeof message.data?.captureId === "string"
				? message.data.captureId
				: null;
		if (
			messageCaptureId &&
			activeCaptureId &&
			messageCaptureId !== activeCaptureId
		) {
			debugWarn("background", "Ignoring stale offscreen capture-error", {
				messageCaptureId,
				activeCaptureId,
			});
			return false;
		}

		const errorCode =
			typeof message.data?.errorCode === "string"
				? message.data.errorCode
				: "capture-setup-failed";
		debugWarn("background", "Offscreen capture error requires recovery", {
			messageCaptureId,
			errorCode,
			requiresRecovery: Boolean(message.data?.requiresRecovery),
		});
		void releaseActiveCapture({
			// Keep a responsive offscreen alive so a late getUserMedia result can
			// be observed and its tracks stopped. Missing ACK still forces close.
			forceCloseOffscreen: false,
			targetTabId: activeCaptureTabId,
			reason: errorCode,
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
		reason:
			event.reason instanceof Error ? event.reason.stack : String(event.reason),
	});
});

setDebugLogContext("background");
bootstrapServiceWorker();
