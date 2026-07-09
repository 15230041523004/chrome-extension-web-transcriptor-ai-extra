import { useCallback, useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import {
	clearDebugLog,
	copyDebugLog,
	DEBUG_BUILD_TAG,
	type DebugEntry,
	subscribeDebugLog,
} from "@/lib/debugLog";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

const BUG_EMOJI = "🐛";
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 288;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function getMaxSize(): { width: number; height: number } {
	return {
		width: Math.max(MIN_WIDTH, window.innerWidth - 12),
		height: Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.8)),
	};
}

function levelClass(level: DebugEntry["level"]): string {
	if (level === "error") {
		return "text-destructive";
	}
	if (level === "warn") {
		return "text-amber-700 dark:text-amber-400";
	}
	return "text-muted-foreground";
}

function ResizeGrip() {
	return (
		<svg
			viewBox="0 0 10 10"
			className="h-2.5 w-2.5 text-muted-foreground/70"
			aria-hidden="true"
		>
			<circle cx="2" cy="8" r="1.1" fill="currentColor" />
			<circle cx="5" cy="8" r="1.1" fill="currentColor" />
			<circle cx="5" cy="5" r="1.1" fill="currentColor" />
			<circle cx="8" cy="5" r="1.1" fill="currentColor" />
		</svg>
	);
}

export function DebugPanel() {
	const panelId = useId();
	const [entries, setEntries] = useState<DebugEntry[]>([]);
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState<string | null>(null);
	const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });

	useEffect(() => subscribeDebugLog(setEntries), []);

	const startResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
		event.preventDefault();
		event.stopPropagation();

		const startX = event.clientX;
		const startY = event.clientY;
		const startWidth = size.width;
		const startHeight = size.height;

		const onPointerMove = (moveEvent: PointerEvent) => {
			const max = getMaxSize();
			const nextWidth = clamp(startWidth + (startX - moveEvent.clientX), MIN_WIDTH, max.width);
			const nextHeight = clamp(startHeight + (startY - moveEvent.clientY), MIN_HEIGHT, max.height);
			setSize({ width: nextWidth, height: nextHeight });
		};

		const onPointerUp = () => {
			document.removeEventListener("pointermove", onPointerMove);
			document.removeEventListener("pointerup", onPointerUp);
		};

		document.addEventListener("pointermove", onPointerMove);
		document.addEventListener("pointerup", onPointerUp);
	}, [size.height, size.width]);

	const latest = entries[entries.length - 1];
	const errorCount = entries.filter((entry) => entry.level === "error").length;
	const warnCount = entries.filter((entry) => entry.level === "warn").length;
	const issueCount = errorCount + warnCount;

	return (
		<div className="pointer-events-auto absolute bottom-0 right-0 z-50">
			{open && (
				<div
					id={panelId}
					role="dialog"
					aria-label="Debug log"
					style={{ width: size.width, height: size.height }}
					className="absolute bottom-full right-0 mb-1 flex flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
				>
					<div className="flex shrink-0 items-stretch border-b border-border bg-muted/30">
						<button
							type="button"
							title="Drag to resize"
							aria-label="Resize debug panel"
							className="flex w-5 shrink-0 cursor-nw-resize items-center justify-center border-r border-border/60 text-muted-foreground transition-colors hover:bg-muted/60"
							onPointerDown={startResize}
						>
							<ResizeGrip />
						</button>

						<div className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1.5">
							<div className="min-w-0">
								<p className="truncate text-xs font-medium text-foreground">Debug log</p>
								<p className="truncate text-[10px] text-muted-foreground">
									{entries.length} lines · {errorCount} err · {warnCount} warn
								</p>
							</div>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								className="h-7 w-7 shrink-0 p-0"
								aria-label="Close debug panel"
								onClick={() => setOpen(false)}
							>
								<X className="h-3.5 w-3.5" />
							</Button>
						</div>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto bg-muted/15 px-2.5 py-2 font-mono text-[10px] leading-relaxed">
						{entries.length === 0 ? (
							<p className="text-muted-foreground">No debug lines yet.</p>
						) : (
							entries.slice(-80).map((entry, index) => (
								<div key={`${entry.ts}-${index}`} className="mb-2 whitespace-pre-wrap break-all">
									<span className={cn("font-medium", levelClass(entry.level))}>
										[{entry.level}] [{entry.context}/{entry.scope}] {entry.message}
									</span>
									{entry.detail ? (
										<div className="mt-0.5 text-muted-foreground">{entry.detail}</div>
									) : null}
								</div>
							))
						)}
					</div>

					<div className="shrink-0 space-y-1.5 border-t border-border bg-muted/20 px-2.5 py-2">
						{latest ? (
							<p className="m-0 truncate text-[10px] text-muted-foreground">
								Last: [{latest.context}/{latest.scope}] {latest.message}
							</p>
						) : null}
						<p className="m-0 text-[10px] text-muted-foreground">{DEBUG_BUILD_TAG}</p>
						{copyError ? (
							<p className="m-0 text-[10px] text-destructive">Copy failed: {copyError}</p>
						) : null}
						<div className="flex gap-1.5">
							<Button
								type="button"
								size="sm"
								variant="secondary"
								className="h-7 flex-1 text-[10px]"
								onClick={async () => {
									try {
										setCopyError(null);
										await copyDebugLog();
										setCopied(true);
										window.setTimeout(() => setCopied(false), 1500);
									} catch (error) {
										setCopyError(error instanceof Error ? error.message : String(error));
									}
								}}
							>
								{copied ? "Copied!" : "Copy FULL log"}
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="h-7 text-[10px]"
								onClick={() => clearDebugLog()}
							>
								Clear
							</Button>
						</div>
					</div>
				</div>
			)}

			<button
				type="button"
				className={cn(
					"relative flex h-9 w-9 translate-x-0.5 translate-y-0.5 items-center justify-center rounded-full border-0 bg-transparent p-0 text-lg leading-none transition-colors select-none",
					"hover:bg-muted/70 active:bg-muted",
					open && "bg-muted/50",
				)}
				aria-label={open ? "Close debug log" : "Open debug log"}
				aria-expanded={open}
				aria-controls={open ? panelId : undefined}
				onPointerDown={(event) => {
					event.stopPropagation();
				}}
				onClick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					setOpen((value) => !value);
				}}
			>
				<span aria-hidden="true">{BUG_EMOJI}</span>
				{issueCount > 0 && (
					<span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-semibold text-destructive-foreground">
						{issueCount > 9 ? "9+" : issueCount}
					</span>
				)}
			</button>
		</div>
	);
}