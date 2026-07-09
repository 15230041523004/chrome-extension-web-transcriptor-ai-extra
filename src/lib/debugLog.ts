export type DebugLevel = "info" | "warn" | "error";

export type DebugContext = "panel" | "background" | "offscreen" | "inline";

export type DebugEntry = {
	ts: string;
	level: DebugLevel;
	scope: string;
	message: string;
	context: DebugContext;
	detail?: string;
};

export type DebugRuntimeState = {
	buildTag?: string;
	isRecording?: boolean;
	pendingCapture?: boolean;
	offscreenReady?: boolean;
	extensionId?: string;
	manifestVersion?: string;
};

const MAX_ENTRIES = 500;
const STORAGE_KEY = "transcriptorDebugLog";
export const DEBUG_BUILD_TAG = "debug-v2-max";

let logContext: DebugContext = "panel";
let memoryLog: DebugEntry[] = [];
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(entries: DebugEntry[]) => void>();

export function setDebugLogContext(context: DebugContext): void {
	logContext = context;
}

function nowIso(): string {
	return new Date().toISOString();
}

function serializeDetail(detail: unknown): string | undefined {
	if (detail === undefined) {
		return undefined;
	}
	if (typeof detail === "string") {
		return detail;
	}
	try {
		return JSON.stringify(detail, null, 2);
	} catch {
		return String(detail);
	}
}

function entryKey(entry: DebugEntry): string {
	return `${entry.ts}|${entry.context}|${entry.scope}|${entry.message}`;
}

function mergeEntries(...lists: DebugEntry[][]): DebugEntry[] {
	const map = new Map<string, DebugEntry>();
	for (const list of lists) {
		for (const entry of list) {
			map.set(entryKey(entry), entry);
		}
	}
	return [...map.values()]
		.sort((a, b) => a.ts.localeCompare(b.ts))
		.slice(-MAX_ENTRIES);
}

function pushEntry(entry: DebugEntry): void {
	memoryLog = mergeEntries(memoryLog, [entry]);
	for (const listener of listeners) {
		listener(memoryLog);
	}

	const line = `[${entry.ts}] [${entry.level}] [${entry.context}/${entry.scope}] ${entry.message}${
		entry.detail ? `\n${entry.detail}` : ""
	}`;
	if (entry.level === "error") {
		console.error(line);
	} else if (entry.level === "warn") {
		console.warn(line);
	} else {
		console.log(line);
	}

	schedulePersist();
}

function schedulePersist(): void {
	if (persistTimer !== null) {
		return;
	}
	persistTimer = setTimeout(() => {
		persistTimer = null;
		void persistMergedLog();
	}, 200);
}

async function readStorageEntries(): Promise<DebugEntry[]> {
	if (typeof chrome === "undefined" || !chrome.storage?.local) {
		return [];
	}

	return new Promise((resolve) => {
		chrome.storage.local.get(STORAGE_KEY, (result) => {
			const stored = result[STORAGE_KEY];
			if (!Array.isArray(stored)) {
				void chrome.runtime.lastError;
				resolve([]);
				return;
			}

			const normalized = stored
				.filter((entry) => entry && typeof entry === "object")
				.map((entry) => ({
					ts: String((entry as DebugEntry).ts ?? ""),
					level: ((entry as DebugEntry).level ?? "info") as DebugLevel,
					scope: String((entry as DebugEntry).scope ?? "unknown"),
					message: String((entry as DebugEntry).message ?? ""),
					context: ((entry as DebugEntry).context ?? "inline") as DebugContext,
					detail:
						typeof (entry as DebugEntry).detail === "string"
							? (entry as DebugEntry).detail
							: undefined,
				}))
				.filter((entry) => entry.ts && entry.message);

			void chrome.runtime.lastError;
			resolve(normalized);
		});
	});
}

async function persistMergedLog(): Promise<void> {
	if (typeof chrome === "undefined" || !chrome.storage?.local) {
		return;
	}

	const stored = await readStorageEntries();
	const merged = mergeEntries(stored, memoryLog);
	memoryLog = merged;

	return new Promise((resolve) => {
		chrome.storage.local.set({ [STORAGE_KEY]: merged }, () => {
			void chrome.runtime.lastError;
			resolve();
		});
	});
}

export function debugLog(
	scope: string,
	message: string,
	detail?: unknown,
	level: DebugLevel = "info",
): void {
	pushEntry({
		ts: nowIso(),
		level,
		scope,
		message,
		context: logContext,
		detail: serializeDetail(detail),
	});
}

export function debugError(scope: string, message: string, detail?: unknown): void {
	debugLog(scope, message, detail, "error");
}

export function debugWarn(scope: string, message: string, detail?: unknown): void {
	debugLog(scope, message, detail, "warn");
}

export function subscribeDebugLog(listener: (entries: DebugEntry[]) => void): () => void {
	listeners.add(listener);
	listener(memoryLog);
	return () => listeners.delete(listener);
}

export async function loadPersistedDebugLog(): Promise<void> {
	const stored = await readStorageEntries();
	if (stored.length > 0) {
		memoryLog = mergeEntries(stored, memoryLog);
		for (const listener of listeners) {
			listener(memoryLog);
		}
	}
	debugLog("debugLog", "Persisted debug log loaded", {
		context: logContext,
		entries: memoryLog.length,
	});
}

function formatEntries(entries: DebugEntry[]): string {
	return entries
		.map((entry) => {
			const base = `[${entry.ts}] [${entry.level}] [${entry.context}/${entry.scope}] ${entry.message}`;
			return entry.detail ? `${base}\n${entry.detail}` : base;
		})
		.join("\n\n");
}

function getEnvironmentHeader(extra?: Record<string, unknown>): string {
	const lines = [
		"=== AI Transcriptior FULL Debug Report ===",
		`build: ${DEBUG_BUILD_TAG}`,
		`context: ${logContext}`,
		`url: ${typeof location !== "undefined" ? location.href : "n/a"}`,
		`userAgent: ${typeof navigator !== "undefined" ? navigator.userAgent : "n/a"}`,
		`entries (local): ${memoryLog.length}`,
		`timestamp: ${nowIso()}`,
	];

	if (extra) {
		lines.push("", "--- runtime state ---", JSON.stringify(extra, null, 2));
	}

	lines.push("", "==========================================", "");
	return lines.join("\n");
}

export function getDebugLogText(): string {
	return `${getEnvironmentHeader()}\n${formatEntries(memoryLog)}\n`;
}

async function fetchBackgroundDebugLog(): Promise<{
	log?: string;
	state?: DebugRuntimeState;
	error?: string;
}> {
	if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
		return { error: "chrome.runtime unavailable" };
	}

	return new Promise((resolve) => {
		chrome.runtime.sendMessage({ type: "get-debug-log" }, (response) => {
			if (chrome.runtime.lastError) {
				resolve({ error: chrome.runtime.lastError.message });
				return;
			}
			resolve({
				log: typeof response?.log === "string" ? response.log : undefined,
				state: response?.state as DebugRuntimeState | undefined,
			});
		});
	});
}

export async function getFullDebugReport(): Promise<string> {
	const [storedEntries, background] = await Promise.all([
		readStorageEntries(),
		fetchBackgroundDebugLog(),
	]);

	const merged = mergeEntries(storedEntries, memoryLog);
	const panelDomSnapshot =
		typeof document !== "undefined"
			? {
					readyState: document.readyState,
					rootExists: Boolean(document.getElementById("root")),
					rootChildCount: document.getElementById("root")?.childElementCount ?? 0,
					bootFallbackVisible: Boolean(document.getElementById("boot-fallback")),
					inlineDebugVisible: Boolean(document.getElementById("inline-debug")),
					panelBooted: Boolean(
						typeof window !== "undefined" &&
							(window as Window & { __TRANSCRIPTOR_PANEL_BOOTED__?: boolean })
								.__TRANSCRIPTOR_PANEL_BOOTED__,
					),
					innerWidth: typeof window !== "undefined" ? window.innerWidth : undefined,
					innerHeight: typeof window !== "undefined" ? window.innerHeight : undefined,
				}
			: undefined;

	const sections = [
		getEnvironmentHeader({
			...background.state,
			panelDomSnapshot,
			backgroundFetchError: background.error,
			storedEntryCount: storedEntries.length,
			mergedEntryCount: merged.length,
		}),
		"--- merged log (storage + panel memory) ---",
		formatEntries(merged),
	];

	if (background.log) {
		sections.push("", "--- background worker log ---", background.log);
	}

	if (background.error) {
		sections.push("", "--- background fetch error ---", background.error);
	}

	return `${sections.join("\n\n")}\n`;
}

export async function copyDebugLog(): Promise<void> {
	const text = await getFullDebugReport();
	await writeTextToClipboard(text);
}

export async function copyDebugLogText(text: string): Promise<void> {
	await writeTextToClipboard(text);
}

async function writeTextToClipboard(text: string): Promise<void> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch (error) {
			debugWarn("debugLog", "clipboard.writeText failed", error);
		}
	}
	debugWarn("debugLog", "Clipboard API unavailable; log printed to console");
	console.log(text);
}

export function clearDebugLog(): void {
	memoryLog = [];
	for (const listener of listeners) {
		listener(memoryLog);
	}
	if (typeof chrome !== "undefined" && chrome.storage?.local) {
		chrome.storage.local.remove(STORAGE_KEY, () => {
			void chrome.runtime.lastError;
		});
	}
}

export function installGlobalDebugHandlers(scope: string): void {
	if (typeof window === "undefined") {
		return;
	}

	window.addEventListener("error", (event) => {
		debugError(scope, "window.error", {
			message: event.message,
			filename: event.filename,
			lineno: event.lineno,
			colno: event.colno,
			error: event.error ? String(event.error.stack ?? event.error) : undefined,
		});
	});

	window.addEventListener("unhandledrejection", (event) => {
		const reason = event.reason;
		debugError(scope, "unhandledrejection", {
			reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
		});
	});

	debugLog(scope, "Global debug handlers installed");
}

export function collectEnvironmentSnapshot(scope: string): void {
	if (typeof window === "undefined") {
		return;
	}

	const root = document.getElementById("root");
	const rootStyle = root ? window.getComputedStyle(root) : null;
	const bodyStyle = window.getComputedStyle(document.body);
	const scripts = [...document.querySelectorAll("script")].map((script) => ({
		src: script.src || "(inline)",
		type: script.type || "classic",
		async: script.async,
		defer: script.defer,
	}));

	debugLog(scope, "Environment snapshot", {
		href: location.href,
		readyState: document.readyState,
		rootExists: Boolean(root),
		rootChildCount: root?.childElementCount ?? 0,
		rootDisplay: rootStyle?.display,
		rootHeight: rootStyle?.height,
		rootMinHeight: rootStyle?.minHeight,
		rootVisibility: rootStyle?.visibility,
		rootOpacity: rootStyle?.opacity,
		bodyHeight: bodyStyle.height,
		bodyBackground: bodyStyle.backgroundColor,
		innerWidth: window.innerWidth,
		innerHeight: window.innerHeight,
		devicePixelRatio: window.devicePixelRatio,
		chromeRuntime: typeof chrome !== "undefined" && Boolean(chrome.runtime),
		chromeStorage: typeof chrome !== "undefined" && Boolean(chrome.storage),
		chromeSidePanel: typeof chrome !== "undefined" && Boolean(chrome.sidePanel),
		panelBooted: Boolean(
			(window as Window & { __TRANSCRIPTOR_PANEL_BOOTED__?: boolean }).__TRANSCRIPTOR_PANEL_BOOTED__,
		),
		scripts,
	});
}

export function markPanelBooted(): void {
	if (typeof window === "undefined") {
		return;
	}
	(window as Window & { __TRANSCRIPTOR_PANEL_BOOTED__?: boolean }).__TRANSCRIPTOR_PANEL_BOOTED__ = true;
	document.getElementById("inline-debug-toggle")?.remove();
	document.getElementById("inline-debug")?.remove();
	window.dispatchEvent(new CustomEvent("transcriptor-panel-booted"));
	debugLog("boot", "Panel marked as booted");
}