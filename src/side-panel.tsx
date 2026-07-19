import ReactDOM from "react-dom/client";
import "./globals.css";
import { ErrorBoundary } from "./components/error-boundary";
import { PanelShell } from "./components/panel-shell";
import { ThemeProvider } from "./components/theme-provider";
import { Toaster } from "./components/ui/toaster";
import SidePanelApp from "./side-panel-app";
import {
	collectEnvironmentSnapshot,
	debugError,
	debugLog,
	installGlobalDebugHandlers,
	loadPersistedDebugLog,
	markPanelBooted,
	setDebugLogContext,
} from "./lib/debugLog";

const BOOT_RELOAD_KEY = "__transcriptor_panel_boot_reload";

setDebugLogContext("panel");
debugLog("boot", "side-panel.tsx module evaluation started");

installGlobalDebugHandlers("side-panel");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function notifyPanelReady() {
	debugLog("boot", "Sending side-panel-ready to background");
	try {
		chrome.runtime.sendMessage({ type: "side-panel-ready" }, (response) => {
			if (chrome.runtime.lastError) {
				debugError("boot", "side-panel-ready failed", chrome.runtime.lastError.message);
				// Extension context not ready yet (common right after Chrome launch).
				// Retry once shortly; do not block UI.
				window.setTimeout(() => {
					chrome.runtime.sendMessage({ type: "side-panel-ready" }, () => {
						void chrome.runtime.lastError;
					});
				}, 500);
				return;
			}
			debugLog("boot", "side-panel-ready response", response);
		});
	} catch (error) {
		debugError("boot", "side-panel-ready threw", error);
	}
}

async function waitForPanelDimensions(maxMs = 500): Promise<{ width: number; height: number }> {
	const started = Date.now();
	while (Date.now() - started < maxMs) {
		if (window.innerWidth > 0 && window.innerHeight > 0) {
			return { width: window.innerWidth, height: window.innerHeight };
		}
		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		});
	}
	return { width: window.innerWidth, height: window.innerHeight };
}

function showBootError(message: string) {
	const root = document.getElementById("root");
	if (!root) return;
	root.innerHTML = `
    <div style="box-sizing:border-box;min-height:100vh;padding:16px;font-family:system-ui,sans-serif;font-size:14px;color:#e5e5e5;background:#0a0a0a">
      <p style="margin:0 0 8px;font-weight:600">Panel failed to start</p>
      <p style="margin:0 0 12px;font-size:12px;color:#a3a3a3">${message}</p>
      <button id="transcriptor-retry-boot" type="button"
        style="cursor:pointer;border:1px solid #52525b;background:#27272a;color:#fafafa;border-radius:6px;padding:8px 12px;font-size:13px">
        Reload panel
      </button>
    </div>
  `;
	document.getElementById("transcriptor-retry-boot")?.addEventListener("click", () => {
		sessionStorage.removeItem(BOOT_RELOAD_KEY);
		location.reload();
	});
}

/**
 * If the React module never finishes booting (restored blank side panel after
 * Chrome launch), reload the page once automatically.
 */
function installBootWatchdog() {
	window.setTimeout(() => {
		if (
			(window as Window & { __TRANSCRIPTOR_PANEL_BOOTED__?: boolean })
				.__TRANSCRIPTOR_PANEL_BOOTED__
		) {
			return;
		}

		const alreadyReloaded = sessionStorage.getItem(BOOT_RELOAD_KEY) === "1";
		debugError(
			"boot",
			alreadyReloaded
				? "Panel still not booted after auto-reload"
				: "Panel not booted in time; reloading side panel once",
		);

		if (!alreadyReloaded) {
			sessionStorage.setItem(BOOT_RELOAD_KEY, "1");
			location.reload();
			return;
		}

		showBootError(
			"The side panel stayed empty after Chrome started. Click Reload panel, or open chrome://extensions and click Reload on AI Transcriptior (Developer mode required for unpacked builds).",
		);
	}, 2500);
}

async function bootSidePanel() {
	// Never block first paint on debug storage — it can hang while the SW is cold.
	try {
		await withTimeout(loadPersistedDebugLog(), 400);
		debugLog("boot", "Persisted debug log loaded");
	} catch {
		debugLog("boot", "Skipping slow debug log load; rendering panel anyway");
	}

	const dimensions = await waitForPanelDimensions(500);
	debugLog("boot", "Panel dimensions ready", dimensions);

	const rootElement = document.getElementById("root");
	if (!rootElement) {
		debugError("boot", "#root element not found");
		return;
	}

	const bootFallback = document.getElementById("boot-fallback");
	if (bootFallback) {
		debugLog("boot", "Removing boot fallback element");
		bootFallback.remove();
	}

	debugLog("boot", "Creating React root");
	const root = ReactDOM.createRoot(rootElement);

	debugLog("boot", "Rendering React tree");
	root.render(
		<ErrorBoundary>
			<ThemeProvider storageKey="chrome-extension-transcriptor-theme">
				<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					<PanelShell>
						<SidePanelApp />
					</PanelShell>
					<Toaster />
				</div>
			</ThemeProvider>
		</ErrorBoundary>,
	);

	debugLog("boot", "React render call completed");
	markPanelBooted();
	try {
		sessionStorage.removeItem(BOOT_RELOAD_KEY);
	} catch {
		// ignore
	}
	collectEnvironmentSnapshot("boot");
	window.setTimeout(() => collectEnvironmentSnapshot("boot+250ms"), 250);
	window.setTimeout(() => collectEnvironmentSnapshot("boot+1000ms"), 1000);
	notifyPanelReady();
}

installBootWatchdog();

void bootSidePanel().catch((error) => {
	debugError("boot", "bootSidePanel failed", error instanceof Error ? error.stack : String(error));
	showBootError(
		error instanceof Error ? error.message : String(error),
	);
});
