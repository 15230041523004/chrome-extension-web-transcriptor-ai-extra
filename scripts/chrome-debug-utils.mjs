import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const root = resolve(__dirname, "..");
export const profilePath = resolve(root, ".vscode/chrome-debug-profile");
export const pidFile = join(profilePath, ".debug-chrome.pid");
export const DEBUG_PORT = 9222;
export const PROFILE_MARKER = "chrome-debug-profile";

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Chrome on Windows misparses backslashes in flag values — always use forward slashes. */
export function toChromeFlagPath(path) {
	return path.replace(/\\/g, "/");
}

export function killProcessTree(pid) {
	if (!pid) {
		return;
	}

	try {
		if (process.platform === "win32") {
			execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
		} else {
			process.kill(Number(pid), "SIGTERM");
		}
	} catch {
		// Process already exited.
	}
}

export function killChromeUsingDebugProfile() {
	if (process.platform === "win32") {
		try {
			execSync(
				`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${PROFILE_MARKER}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
				{ stdio: "ignore" },
			);
		} catch {
			// Ignore cleanup errors.
		}
		return;
	}

	try {
		const output = execSync("ps ax -o pid=,command=", { encoding: "utf8" });
		for (const line of output.split("\n")) {
			if (line.includes(PROFILE_MARKER)) {
				const pid = line.trim().split(/\s+/)[0];
				killProcessTree(pid);
			}
		}
	} catch {
		// Ignore cleanup errors.
	}
}

export function killDebugChrome() {
	if (existsSync(pidFile)) {
		killProcessTree(readFileSync(pidFile, "utf8").trim());
		try {
			rmSync(pidFile);
		} catch {
			// Ignore cleanup errors.
		}
	}

	killChromeUsingDebugProfile();
}

export function waitForDebugPort(port, attempts = 80, delayMs = 250) {
	return new Promise((resolvePromise, rejectPromise) => {
		let tries = 0;

		const check = () => {
			fetch(`http://127.0.0.1:${port}/json/version`)
				.then((response) => {
					if (response.ok) {
						resolvePromise();
						return;
					}
					retry();
				})
				.catch(retry);
		};

		const retry = () => {
			tries += 1;
			if (tries >= attempts) {
				rejectPromise(new Error(`Chrome debug port ${port} did not become ready.`));
				return;
			}
			setTimeout(check, delayMs);
		};

		setTimeout(check, delayMs);
	});
}

export async function fetchDebugTargets(port) {
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	if (!response.ok) {
		throw new Error(`Failed to list debug targets: ${response.status}`);
	}
	return response.json();
}

export async function waitForExtensionServiceWorker(
	port,
	extensionId,
	{ attempts = 40, delayMs = 250 } = {},
) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const targets = await fetchDebugTargets(port);
			const serviceWorker = targets.find(
				(target) =>
					target.type === "service_worker" &&
					typeof target.url === "string" &&
					target.url.startsWith(`chrome-extension://${extensionId}/`),
			);
			if (serviceWorker) {
				return serviceWorker;
			}
		} catch {
			// Retry until timeout.
		}
		await sleep(delayMs);
	}

	return null;
}

export async function sendBrowserCdpCommand(port, method, params = {}) {
	const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => {
		if (!response.ok) {
			throw new Error(`CDP version check failed: ${response.status}`);
		}
		return response.json();
	});

	const wsUrl = version.webSocketDebuggerUrl;
	if (!wsUrl) {
		throw new Error("Chrome did not expose a WebSocket debugger URL.");
	}

	return new Promise((resolvePromise, rejectPromise) => {
		const ws = new WebSocket(wsUrl);
		const id = Math.floor(Math.random() * 1_000_000);
		let settled = false;

		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				ws.close();
				rejectPromise(new Error(`CDP timeout while calling ${method}`));
			}
		}, 30_000);

		const finish = (error, result) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			ws.close();
			if (error) {
				rejectPromise(error);
				return;
			}
			resolvePromise(result);
		};

		ws.addEventListener("open", () => {
			ws.send(JSON.stringify({ id, method, params }));
		});

		ws.addEventListener("message", (event) => {
			try {
				const parsed = JSON.parse(event.data.toString());
				if (parsed.id !== id) {
					return;
				}
				if (parsed.error) {
					finish(new Error(parsed.error.message), undefined);
					return;
				}
				finish(undefined, parsed.result);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)), undefined);
			}
		});

		ws.addEventListener("error", () => {
			finish(new Error(`WebSocket error while calling ${method}`), undefined);
		});
	});
}

export async function reloadExtensionOnDebugPort(port, extensionPath) {
	return sendBrowserCdpCommand(port, "Extensions.loadUnpacked", {
		path: toChromeFlagPath(extensionPath),
	});
}

export async function ensureExtensionReady(port, extensionPath) {
	console.log("Reloading extension via CDP...");
	const loadResult = await reloadExtensionOnDebugPort(port, extensionPath);
	const extensionId = loadResult?.id;
	if (!extensionId) {
		throw new Error("Chrome did not return an extension id after reload.");
	}

	console.log(`Extension installed (id: ${extensionId}).`);
	const serviceWorker = await waitForExtensionServiceWorker(port, extensionId);
	if (serviceWorker) {
		await sleep(500);
		console.log("Extension service worker is active.");
	} else {
		console.warn(
			"Service worker not visible in CDP yet (normal for MV3 when idle). Extension should still appear in chrome://extensions.",
		);
	}

	return loadResult;
}