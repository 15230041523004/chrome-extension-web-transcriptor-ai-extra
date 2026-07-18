import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const root = resolve(__dirname, "..");
export const profilePath = resolve(root, ".vscode/chrome-debug-profile");
export const pidFile = join(profilePath, ".debug-chrome.pid");
export const DEBUG_PORT = 9333;
export const PROFILE_MARKER = "chrome-debug-profile";

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
		await sleep(500);
		console.log("Extension service worker is active.");
	} else {
		console.warn(
			"Service worker not visible in CDP yet (normal for MV3 when idle). Extension should still appear in chrome://extensions.",
		);
	}

	return { id: extensionId };
}
