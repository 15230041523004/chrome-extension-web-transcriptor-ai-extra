(() => {
	var STORAGE_KEY = "transcriptorDebugLog";
	var MAX_ENTRIES = 500;
	var bootTs = new Date().toISOString();

	function hasChromeStorage() {
		return (
			typeof chrome !== "undefined" && chrome.storage && chrome.storage.local
		);
	}

	function pushInlineLog(level, scope, message, detail) {
		var entry = {
			ts: new Date().toISOString(),
			level: level,
			scope: scope,
			message: message,
			context: "inline",
			detail: detail ? JSON.stringify(detail) : undefined,
		};
		console.log("[inline-debug]", entry);
		try {
			if (hasChromeStorage()) {
				chrome.storage.local.get(STORAGE_KEY, (result) => {
					var log = Array.isArray(result[STORAGE_KEY])
						? result[STORAGE_KEY]
						: [];
					log.push(entry);
					chrome.storage.local.set({
						[STORAGE_KEY]: log.slice(-MAX_ENTRIES),
					});
				});
			}
		} catch (error) {
			console.error("[inline-debug] persist failed", error);
		}
		updateInlineDebugView(entry);
	}

	function updateInlineDebugView(lastEntry) {
		var status = document.getElementById("inline-debug-status");
		var logEl = document.getElementById("inline-debug-log");
		if (status && lastEntry) {
			status.textContent = `[${lastEntry.level}] [${lastEntry.scope}] ${lastEntry.message}`;
		}
		if (logEl && hasChromeStorage()) {
			chrome.storage.local.get(STORAGE_KEY, (result) => {
				var log = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
				var lines = log
					.slice(-12)
					.map(
						(entry) =>
							"[" +
							entry.level +
							"] [" +
							(entry.context || "inline") +
							"/" +
							entry.scope +
							"] " +
							entry.message,
					);
				logEl.textContent = lines.join("\n") || "(no log lines yet)";
			});
		}
	}

	function buildInlineReport(
		storedLog,
		backgroundLog,
		backgroundState,
		backgroundError,
	) {
		var root = document.getElementById("root");
		var lines = [
			"=== AI Transcriptior FULL Debug Report (inline copy) ===",
			"build: debug-v2-max",
			`url: ${location.href}`,
			`userAgent: ${navigator.userAgent}`,
			`bootTs: ${bootTs}`,
			`readyState: ${document.readyState}`,
			`panelBooted: ${Boolean(window.__TRANSCRIPTOR_PANEL_BOOTED__)}`,
			`rootChildCount: ${root ? root.childElementCount : -1}`,
			`bootFallbackVisible: ${Boolean(document.getElementById("boot-fallback"))}`,
			"",
		];
		if (backgroundState) {
			lines.push(
				"--- background state ---",
				JSON.stringify(backgroundState, null, 2),
				"",
			);
		}
		if (backgroundError) {
			lines.push("--- background fetch error ---", backgroundError, "");
		}
		lines.push("--- storage log ---");
		if (Array.isArray(storedLog) && storedLog.length) {
			for (let index = 0; index < storedLog.length; index += 1) {
				const entry = storedLog[index];
				lines.push(
					"[" +
						entry.ts +
						"] [" +
						entry.level +
						"] [" +
						(entry.context || "inline") +
						"/" +
						entry.scope +
						"] " +
						entry.message,
				);
				if (entry.detail) lines.push(entry.detail);
			}
		} else {
			lines.push("(empty)");
		}
		if (backgroundLog) {
			lines.push("", "--- background worker log ---", backgroundLog);
		}
		return lines.join("\n");
	}

	function copyInlineDebugLog() {
		var button = document.getElementById("inline-copy-log");
		if (button) button.textContent = "Copying...";
		var storedLog = [];
		var done = (backgroundLog, backgroundState, backgroundError) => {
			var text = buildInlineReport(
				storedLog,
				backgroundLog,
				backgroundState,
				backgroundError,
			);
			function finishCopied() {
				if (button) {
					button.textContent = "Copied!";
					setTimeout(() => {
						button.textContent = "Copy FULL log";
					}, 1500);
				}
			}
			if (navigator.clipboard?.writeText) {
				navigator.clipboard
					.writeText(text)
					.then(finishCopied)
					.catch(() => {
						console.log(text);
						finishCopied();
					});
			} else {
				console.log(text);
				finishCopied();
			}
		};

		if (!hasChromeStorage()) {
			done(null, null, "chrome.storage unavailable");
			return;
		}

		chrome.storage.local.get(STORAGE_KEY, (result) => {
			storedLog = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
			if (chrome.runtime?.sendMessage) {
				chrome.runtime.sendMessage({ type: "get-debug-log" }, (response) => {
					var error = chrome.runtime.lastError
						? chrome.runtime.lastError.message
						: null;
					done(response?.log, response?.state, error);
				});
			} else {
				done(null, null, "chrome.runtime unavailable");
			}
		});
	}

	pushInlineLog("info", "inline", "sidepanel external boot script executed", {
		href: location.href,
		readyState: document.readyState,
	});

	window.addEventListener("error", (event) => {
		pushInlineLog("error", "inline", "window.error", {
			message: event.message,
			filename: event.filename,
			lineno: event.lineno,
			colno: event.colno,
		});
	});

	window.addEventListener("unhandledrejection", (event) => {
		pushInlineLog("error", "inline", "unhandledrejection", {
			reason: String(event.reason),
		});
	});

	function setInlineDebugOpen(open) {
		var panel = document.getElementById("inline-debug");
		var toggle = document.getElementById("inline-debug-toggle");
		if (panel) panel.hidden = !open;
		if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
	}

	window.addEventListener("transcriptor-panel-booted", () => {
		pushInlineLog(
			"info",
			"inline",
			"React panel booted - hiding inline debug UI",
		);
		var panel = document.getElementById("inline-debug");
		var toggle = document.getElementById("inline-debug-toggle");
		if (panel) panel.hidden = true;
		if (toggle) toggle.style.display = "none";
	});

	document.addEventListener("DOMContentLoaded", () => {
		var copyButton = document.getElementById("inline-copy-log");
		var toggleButton = document.getElementById("inline-debug-toggle");
		if (copyButton) copyButton.addEventListener("click", copyInlineDebugLog);
		if (toggleButton) {
			toggleButton.addEventListener("click", () => {
				var panel = document.getElementById("inline-debug");
				setInlineDebugOpen(Boolean(panel?.hidden));
			});
		}
		setInlineDebugOpen(false);
		updateInlineDebugView(null);

		setTimeout(() => {
			if (!window.__TRANSCRIPTOR_PANEL_BOOTED__) {
				pushInlineLog("warn", "inline", "Panel module not booted after 3s", {
					bootFallbackVisible: Boolean(
						document.getElementById("boot-fallback"),
					),
					rootChildCount: document.getElementById("root")
						? document.getElementById("root").childElementCount
						: -1,
				});
			}
		}, 3000);

		setTimeout(() => {
			if (!window.__TRANSCRIPTOR_PANEL_BOOTED__) {
				pushInlineLog(
					"error",
					"inline",
					"Panel module STILL not booted after 10s - likely JS load/render failure",
				);
			}
		}, 10000);
	});

	window.__TRANSCRIPTOR_INLINE_DEBUG__ = {
		pushInlineLog: pushInlineLog,
		copyInlineDebugLog: copyInlineDebugLog,
	};
})();
