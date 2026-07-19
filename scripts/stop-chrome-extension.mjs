import { killDebugChrome } from "./chrome-debug-utils.mjs";

const result = await killDebugChrome();
console.log(
	result.graceful
		? "Debug Chrome closed cleanly."
		: "Debug Chrome processes stopped with fallback cleanup.",
);
