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

setDebugLogContext("panel");
debugLog("boot", "side-panel.tsx module evaluation started");

installGlobalDebugHandlers("side-panel");

function notifyPanelReady() {
	debugLog("boot", "Sending side-panel-ready to background");
	chrome.runtime.sendMessage({ type: "side-panel-ready" }, (response) => {
		if (chrome.runtime.lastError) {
			debugError("boot", "side-panel-ready failed", chrome.runtime.lastError.message);
			return;
		}
		debugLog("boot", "side-panel-ready response", response);
	});
}

async function waitForPanelDimensions(maxMs = 4000): Promise<{ width: number; height: number }> {
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

async function bootSidePanel() {
	await loadPersistedDebugLog();
	debugLog("boot", "Persisted debug log loaded");

	const dimensions = await waitForPanelDimensions();
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
	collectEnvironmentSnapshot("boot");
	window.setTimeout(() => collectEnvironmentSnapshot("boot+250ms"), 250);
	window.setTimeout(() => collectEnvironmentSnapshot("boot+1000ms"), 1000);
	window.setTimeout(() => collectEnvironmentSnapshot("boot+3000ms"), 3000);
	notifyPanelReady();
}

void bootSidePanel().catch((error) => {
	debugError("boot", "bootSidePanel failed", error instanceof Error ? error.stack : String(error));
});