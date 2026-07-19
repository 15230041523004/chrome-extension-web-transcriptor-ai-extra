import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const root = resolve(__dirname, "..");
export const profilePath = resolve(root, ".vscode/chrome-debug-profile");
export const pidFile = join(profilePath, ".debug-chrome.pid");
export const DEBUG_PORT = 9333;
export const PROFILE_MARKER = "chrome-debug-profile";
const GRACEFUL_CLOSE_TIMEOUT_MS = 5000;

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ensureDebugPortAvailable(port) {
	return new Promise((resolvePromise, rejectPromise) => {
		const server = createServer();
		server.unref();
		server.once("error", (error) => {
			if (error.code === "EADDRINUSE") {
				rejectPromise(
					new Error(
						`Chrome debug port ${port} is already in use. Stop the conflicting process or choose another port.`,
					),
				);
				return;
			}
			rejectPromise(error);
		});
		server.listen(port, "127.0.0.1", () => {
			server.close(resolvePromise);
		});
	});
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

async function waitForDebugPortToClose(
	port,
	timeoutMs = GRACEFUL_CLOSE_TIMEOUT_MS,
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await fetch(`http://127.0.0.1:${port}/json/version`, {
				signal: AbortSignal.timeout(300),
			});
		} catch {
			return true;
		}
		await sleep(100);
	}
	return false;
}

async function closeChromeViaDebugPort(port) {
	let version;
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
			signal: AbortSignal.timeout(1000),
		});
		if (!response.ok) {
			return false;
		}
		version = await response.json();
	} catch {
		return false;
	}

	if (typeof version.webSocketDebuggerUrl !== "string") {
		return false;
	}

	return new Promise((resolvePromise) => {
		const requestId = Math.floor(Math.random() * 1_000_000);
		let commandSent = false;
		let settled = false;
		const socket = new WebSocket(version.webSocketDebuggerUrl);
		const timer = setTimeout(() => finish(false), GRACEFUL_CLOSE_TIMEOUT_MS);

		const finish = (closed) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			try {
				socket.close();
			} catch {
				// Browser may already have closed the socket.
			}
			resolvePromise(closed);
		};

		socket.addEventListener("open", () => {
			commandSent = true;
			socket.send(JSON.stringify({ id: requestId, method: "Browser.close" }));
		});
		socket.addEventListener("message", (event) => {
			try {
				const response = JSON.parse(String(event.data));
				if (response.id === requestId) {
					finish(!response.error);
				}
			} catch {
				// Ignore unrelated or malformed CDP messages.
			}
		});
		socket.addEventListener("close", () => finish(commandSent));
		socket.addEventListener("error", () => finish(false));
	});
}

/**
 * Close the dedicated debug Chrome cleanly so its next run does not restore a
 * crashed side-panel session. Force-kill is retained only as a last resort.
 */
export async function killDebugChrome() {
	const storedPid = existsSync(pidFile)
		? readFileSync(pidFile, "utf8").trim()
		: null;
	const gracefulCloseRequested = await closeChromeViaDebugPort(DEBUG_PORT);

	if (gracefulCloseRequested && (await waitForDebugPortToClose(DEBUG_PORT))) {
		// Give Chrome a final moment to flush profile state after releasing CDP.
		await sleep(300);
		try {
			rmSync(pidFile);
		} catch {
			// Ignore cleanup errors.
		}
		return { graceful: true, forced: false };
	}

	if (existsSync(pidFile)) {
		killProcessTree(storedPid);
		try {
			rmSync(pidFile);
		} catch {
			// Ignore cleanup errors.
		}
	}

	killChromeUsingDebugProfile();
	return { graceful: false, forced: true };
}

/**
 * Repair only Chrome's crash marker in our dedicated debug profile. All tabs,
 * extension storage, downloaded models, and other profile data are preserved.
 */
export function normalizeDebugProfileExitState() {
	const preferencesPath = join(profilePath, "Default", "Preferences");
	if (!existsSync(preferencesPath)) {
		return false;
	}

	try {
		const preferences = JSON.parse(readFileSync(preferencesPath, "utf8"));
		if (preferences.profile?.exit_type !== "Crashed") {
			return false;
		}
		preferences.profile.exit_type = "Normal";
		writeFileSync(preferencesPath, JSON.stringify(preferences));
		return true;
	} catch {
		return false;
	}
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
				rejectPromise(
					new Error(`Chrome debug port ${port} did not become ready.`),
				);
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

export async function ensureExtensionReady(port, extensionId) {
	console.log(`Checking extension startup (id: ${extensionId})...`);
	const serviceWorker = await waitForExtensionServiceWorker(port, extensionId);
	if (serviceWorker) {
		await sleep(300);
		console.log("Extension service worker is active.");
	} else {
		console.warn(
			"Service worker not visible in CDP yet (normal for MV3 when idle). Extension should still appear in chrome://extensions.",
		);
	}

	return { id: extensionId };
}
