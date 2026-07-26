export type ActiveBrowserTab = {
	id: number;
	url?: string;
	title?: string;
	windowId?: number;
};

function tabUrl(tab: chrome.tabs.Tab): string | undefined {
	return tab.url || tab.pendingUrl || undefined;
}

function toActiveTab(tab: chrome.tabs.Tab): ActiveBrowserTab | null {
	if (typeof tab.id !== "number") return null;
	return {
		id: tab.id,
		url: tabUrl(tab),
		title: tab.title,
		windowId: tab.windowId,
	};
}

/**
 * Resolve the active tab in a normal browser window.
 * Side panels often fail with `currentWindow` / naive lastFocused queries when
 * the panel itself holds focus (common on Brave).
 */
export async function getActiveBrowserTab(): Promise<ActiveBrowserTab | null> {
	// 1) Explicit normal window last-focused (best for docked side panels).
	try {
		const lastFocused = await chrome.windows.getLastFocused({
			populate: true,
			windowTypes: ["normal"],
		});
		const focusedActive = lastFocused.tabs?.find((tab) => tab.active);
		const resolved = focusedActive ? toActiveTab(focusedActive) : null;
		if (resolved) return resolved;
	} catch {
		// Fall through.
	}

	// 2) Classic query used by Chrome side-panel docs.
	try {
		const [tab] = await chrome.tabs.query({
			active: true,
			lastFocusedWindow: true,
		});
		const resolved = tab ? toActiveTab(tab) : null;
		if (resolved) return resolved;
	} catch {
		// Fall through.
	}

	// 3) Any active http(s) tab, preferring YouTube if several windows are open.
	try {
		const activeTabs = await chrome.tabs.query({ active: true });
		const withUrl = activeTabs
			.map((tab) => toActiveTab(tab))
			.filter((tab): tab is ActiveBrowserTab => Boolean(tab));

		const youtube = withUrl.find((tab) =>
			/youtube\.com|youtu\.be/i.test(tab.url ?? ""),
		);
		if (youtube) return youtube;

		const web = withUrl.find((tab) => /^https?:\/\//i.test(tab.url ?? ""));
		if (web) return web;

		if (withUrl[0]) return withUrl[0];
	} catch {
		// Fall through.
	}

	// 4) Full window scan.
	const windows = await chrome.windows.getAll({
		populate: true,
		windowTypes: ["normal"],
	});
	const preferred =
		windows.find((win) => win.focused) ??
		windows.find((win) => win.tabs?.some((tab) => tab.active));

	const active = preferred?.tabs?.find((tab) => tab.active);
	const fromPreferred = active ? toActiveTab(active) : null;
	if (fromPreferred) return fromPreferred;

	for (const win of windows) {
		const tab = win.tabs?.find((entry) => entry.active);
		const resolved = tab ? toActiveTab(tab) : null;
		if (resolved) return resolved;
	}

	return null;
}

/** Subscribe to tab/window changes that can affect the active browser page. */
export function subscribeActiveBrowserTab(
	onChange: (tab: ActiveBrowserTab | null) => void,
): () => void {
	let cancelled = false;

	const refresh = () => {
		void getActiveBrowserTab()
			.then((tab) => {
				if (!cancelled) onChange(tab);
			})
			.catch(() => {
				if (!cancelled) onChange(null);
			});
	};

	refresh();

	const onActivated = () => refresh();
	const onUpdated = (
		_tabId: number,
		changeInfo: chrome.tabs.OnUpdatedInfo,
	) => {
		if (
			changeInfo.url ||
			changeInfo.status === "loading" ||
			changeInfo.status === "complete" ||
			changeInfo.title
		) {
			refresh();
		}
	};
	const onFocusChanged = () => refresh();
	const onRemoved = () => refresh();
	const onReplaced = () => refresh();

	chrome.tabs.onActivated.addListener(onActivated);
	chrome.tabs.onUpdated.addListener(onUpdated);
	chrome.tabs.onRemoved.addListener(onRemoved);
	chrome.tabs.onReplaced?.addListener(onReplaced);
	chrome.windows.onFocusChanged.addListener(onFocusChanged);

	// Keep polling while the panel is open: focus quirks on Brave/Chromium
	// can leave the first query on a non-page context.
	const poll = window.setInterval(refresh, 1_000);

	return () => {
		cancelled = true;
		window.clearInterval(poll);
		chrome.tabs.onActivated.removeListener(onActivated);
		chrome.tabs.onUpdated.removeListener(onUpdated);
		chrome.tabs.onRemoved.removeListener(onRemoved);
		chrome.tabs.onReplaced?.removeListener(onReplaced);
		chrome.windows.onFocusChanged.removeListener(onFocusChanged);
	};
}
