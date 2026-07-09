import * as ChromeLauncher from "chrome-launcher";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEBUG_PORT,
	ensureExtensionReady,
	killDebugChrome,
	pidFile,
	profilePath,
	sleep,
	toChromeFlagPath,
	waitForDebugPort,
} from "./chrome-debug-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const distPath = realpathSync.native(resolve(root, "dist"));
const PROFILE_SYNC_DELAY_MS = 1500;

function findChrome() {
	if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
		return process.env.CHROME_PATH;
	}

	const installations = ChromeLauncher.Launcher.getInstallations();
	return installations[0];
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
		params: { path: toChromeFlagPath(extensionPath) },
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

async function installExtensionIntoProfile(extensionPath, profilePath) {
	const chromeFlags = ChromeLauncher.Launcher.defaultFlags()
		.filter((flag) => flag !== "--disable-extensions")
		.concat([
			`--user-data-dir=${toChromeFlagPath(profilePath)}`,
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
		`--user-data-dir=${toChromeFlagPath(profilePath)}`,
		`--remote-debugging-port=${DEBUG_PORT}`,
		"--remote-allow-origins=*",
		"--enable-unsafe-extension-debugging",
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
	killDebugChrome();

	console.log("Installing extension into the debug Chrome profile...");
	console.log(`  Extension: ${distPath}`);

	const loadResult = await installExtensionIntoProfile(distPath, profilePath);
	console.log(`Extension registered in profile (id: ${loadResult.id}).`);

	console.log(`Waiting ${PROFILE_SYNC_DELAY_MS}ms for profile sync...`);
	await sleep(PROFILE_SYNC_DELAY_MS);

	console.log("Launching Chrome for debugging...");
	const child = await launchDebugChrome(url, profilePath);

	if (child.pid) {
		writeFileSync(pidFile, String(child.pid));
	}

	child.unref();

	console.log("Waiting for Chrome debug port...");
	await waitForDebugPort(DEBUG_PORT);
	await sleep(1000);

	await ensureExtensionReady(DEBUG_PORT, distPath);

	console.log(`Chrome started (PID ${child.pid ?? "unknown"}).`);
	console.log(`Debugger port: ${DEBUG_PORT}`);
	console.log("Open chrome://extensions — AI Transcriptior should be listed and enabled.");
	console.log("To stop debug Chrome later, run: npm run stop:chrome");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});