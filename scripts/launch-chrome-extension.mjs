import * as ChromeLauncher from "chrome-launcher";
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const distPath = realpathSync.native(resolve(root, "dist"));
const profilePath = resolve(root, ".vscode/chrome-debug-profile");
const pidFile = join(profilePath, ".debug-chrome.pid");
const DEBUG_PORT = 9222;
const PROFILE_MARKER = "chrome-debug-profile";

function findChrome() {
	if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
		return process.env.CHROME_PATH;
	}

	const installations = ChromeLauncher.Launcher.getInstallations();
	return installations[0];
}

function killProcessTree(pid) {
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

function killChromeUsingDebugProfile() {
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

function killPreviousChrome() {
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

function waitForDebugPort(port, attempts = 80, delayMs = 250) {
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

async function loadExtensionViaPipe(chromeInstance, extensionPath) {
	const pipes = chromeInstance.remoteDebuggingPipes;
	if (!pipes) {
		throw new Error("Chrome did not expose remote debugging pipes.");
	}

	const requestId = Math.floor(Math.random() * 1_000_000);
	const request = {
		id: requestId,
		method: "Extensions.loadUnpacked",
		params: { path: extensionPath },
	};

	const response = await new Promise((resolvePromise, rejectPromise) => {
		let buffer = "";
		const timeout = setTimeout(() => {
			rejectPromise(new Error("Timed out while loading the extension via CDP pipe."));
		}, 30_000);

		const cleanup = () => {
			clearTimeout(timeout);
			pipes.incoming.off("data", onData);
			pipes.incoming.off("error", onError);
			pipes.incoming.off("close", onClose);
		};

		const onData = (chunk) => {
			buffer += chunk.toString();
			let end = buffer.indexOf("\0");

			while (end !== -1) {
				const message = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				end = buffer.indexOf("\0");

				try {
					const parsed = JSON.parse(message);
					if (parsed.id !== requestId) {
						continue;
					}

					cleanup();
					resolvePromise(parsed);
					return;
				} catch {
					// Ignore non-JSON noise on the pipe.
				}
			}
		};

		const onError = (error) => {
			cleanup();
			rejectPromise(error);
		};

		const onClose = () => {
			cleanup();
			rejectPromise(new Error("Chrome debugging pipe closed before the extension loaded."));
		};

		pipes.incoming.on("data", onData);
		pipes.incoming.on("error", onError);
		pipes.incoming.on("close", onClose);
		pipes.outgoing.write(`${JSON.stringify(request)}\0`);
	});

	if (response.error) {
		throw new Error(response.error.message);
	}

	return response.result;
}

async function installExtension(extensionPath, profilePath) {
	const chromeFlags = ChromeLauncher.Launcher.defaultFlags()
		.filter((flag) => flag !== "--disable-extensions")
		.concat([
			`--user-data-dir=${profilePath}`,
			"--remote-debugging-pipe",
			"--enable-unsafe-extension-debugging",
			"--no-first-run",
			"--no-default-browser-check",
		]);

	const chromeInstance = await ChromeLauncher.launch({
		ignoreDefaultFlags: true,
		chromeFlags,
		startingUrl: "about:blank",
		chromePath: findChrome(),
	});

	try {
		return await loadExtensionViaPipe(chromeInstance, extensionPath);
	} finally {
		await chromeInstance.kill();
	}
}

async function launchDebugChrome(url, profilePath) {
	const chromePath = findChrome();
	if (!chromePath) {
		throw new Error(
			"Google Chrome not found. Install Chrome or set the CHROME_PATH environment variable.",
		);
	}

	const args = [
		`--user-data-dir=${profilePath}`,
		`--remote-debugging-port=${DEBUG_PORT}`,
		"--remote-allow-origins=*",
		"--no-first-run",
		"--no-default-browser-check",
		url,
	];

	const child = spawn(chromePath, args, {
		detached: true,
		stdio: "ignore",
		windowsHide: false,
	});

	return new Promise((resolvePromise, rejectPromise) => {
		child.once("error", rejectPromise);
		child.once("spawn", () => resolvePromise(child));
	});
}

async function main() {
	if (!existsSync(join(distPath, "manifest.json"))) {
		console.error(`Extension build not found at ${distPath}. Run "npm run build" first.`);
		process.exit(1);
	}

	const url = process.argv[2] || "about:blank";

	mkdirSync(profilePath, { recursive: true });
	killPreviousChrome();

	console.log("Installing extension into the debug Chrome profile...");
	console.log(`  Extension: ${distPath}`);

	const loadResult = await installExtension(distPath, profilePath);
	console.log(`Extension installed/updated: AI Transcriptior (id: ${loadResult.id}).`);

	console.log("Launching Chrome for debugging...");
	const child = await launchDebugChrome(url, profilePath);

	if (child.pid) {
		writeFileSync(pidFile, String(child.pid));
	}

	child.unref();
	await waitForDebugPort(DEBUG_PORT);

	console.log(`Chrome started (PID ${child.pid ?? "unknown"}).`);
	console.log(`Debugger port: ${DEBUG_PORT}`);
	console.log("Open chrome://extensions to verify the extension is listed.");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});