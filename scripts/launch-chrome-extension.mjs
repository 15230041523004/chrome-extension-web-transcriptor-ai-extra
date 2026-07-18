import * as ChromeLauncher from "chrome-launcher";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEBUG_PORT,
	ensureDebugPortAvailable,
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
const distPath = resolve(root, "dist");

function findChrome() {
	if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
		return process.env.CHROME_PATH;
	}

	const installations = ChromeLauncher.Launcher.getInstallations();
	return installations[0];
}

async function sendCdpCommandViaPipe(chromeInstance, method, params = {}) {
	const pipes = chromeInstance.remoteDebuggingPipes;
	if (!pipes) {
		throw new Error("Chrome did not expose remote debugging pipes.");
	}

	const requestId = Math.floor(Math.random() * 1_000_000);
	const request = {
		id: requestId,
		method,
		params,
	};

	const response = await new Promise((resolvePromise, rejectPromise) => {
		let buffer = "";
		const timeout = setTimeout(() => {
			rejectPromise(new Error(`CDP pipe timeout while calling ${method}.`));
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
			rejectPromise(
				new Error(`Chrome debugging pipe closed while calling ${method}.`),
			);
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

/**
 * chrome-launcher defaultFlags() are Lighthouse-oriented automation flags.
 * Several of them break real media playback / YouTube while debugging an extension:
 * - --mute-audio → no sound at all (and tabCapture gets silence)
 * - --disable-component-update → Widevine / media components never update
 * - --disable-extensions → filtered so we can load our unpacked extension
 */
const AUTOMATION_FLAGS_TO_DROP = new Set([
	"--disable-extensions",
	"--mute-audio",
	"--disable-component-update",
	"--disable-component-extensions-with-background-pages",
]);

async function launchDebugChrome(url, profileDir) {
	const chromeFlags = ChromeLauncher.Launcher.defaultFlags()
		.filter((flag) => !AUTOMATION_FLAGS_TO_DROP.has(flag))
		.concat([
			`--user-data-dir=${toChromeFlagPath(profileDir)}`,
			"--remote-debugging-pipe",
			`--remote-debugging-port=${DEBUG_PORT}`,
			"--remote-allow-origins=*",
			"--enable-unsafe-extension-debugging",
			"--no-first-run",
			"--no-default-browser-check",
			// Allow media autoplay without a prior click (handy for extension testing).
			"--autoplay-policy=no-user-gesture-required",
		]);

	const chromeInstance = await ChromeLauncher.launch({
		ignoreDefaultFlags: true,
		chromeFlags,
		startingUrl: url,
		chromePath: findChrome(),
	});

	return chromeInstance;
}

async function main() {
	const manifestPath = join(distPath, "manifest.json");
	if (!existsSync(manifestPath)) {
		console.error(
			`Extension build not found at ${distPath}. Run "npm run build" first.`,
		);
		process.exit(1);
	}
	const extensionPath = realpathSync.native(distPath);

	const url = process.argv[2] || "about:blank";

	mkdirSync(profilePath, { recursive: true });
	killDebugChrome();
	await ensureDebugPortAvailable(DEBUG_PORT);

	console.log("Launching Chrome for debugging...");
	const chromeInstance = await launchDebugChrome(url, profilePath);

	if (chromeInstance.pid) {
		writeFileSync(pidFile, String(chromeInstance.pid));
	}

	try {
		console.log("Installing extension into the debug Chrome process...");
		console.log(`  Extension: ${extensionPath}`);
		const loadResult = await sendCdpCommandViaPipe(
			chromeInstance,
			"Extensions.loadUnpacked",
			{ path: toChromeFlagPath(extensionPath) },
		);
		const extensionList = await sendCdpCommandViaPipe(
			chromeInstance,
			"Extensions.getExtensions",
		);
		const installedExtension = extensionList.extensions?.find(
			(extension) => extension.id === loadResult.id && extension.enabled,
		);
		if (!installedExtension) {
			throw new Error(
				`Chrome did not keep extension ${loadResult.id} enabled after installation.`,
			);
		}
		console.log(`Extension installed (id: ${loadResult.id}).`);

		console.log("Waiting for Chrome debug port...");
		await waitForDebugPort(DEBUG_PORT);
		await sleep(1000);

		await ensureExtensionReady(DEBUG_PORT, loadResult.id);

		console.log(`Chrome started (PID ${chromeInstance.pid ?? "unknown"}).`);
		console.log(`Debugger port: ${DEBUG_PORT}`);
		console.log(
			"Open chrome://extensions — AI Transcriptior should be listed and enabled.",
		);
		console.log("To stop debug Chrome later, run: npm run stop:chrome");

		await new Promise((resolvePromise, rejectPromise) => {
			chromeInstance.process.once("exit", resolvePromise);
			chromeInstance.process.once("error", rejectPromise);
		});
	} catch (error) {
		if (chromeInstance.process.exitCode === null) {
			chromeInstance.kill();
		}
		throw error;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
