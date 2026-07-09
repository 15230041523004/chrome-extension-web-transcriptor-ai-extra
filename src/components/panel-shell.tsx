import { type ReactNode, useEffect, useState } from "react";
import { debugLog } from "@/lib/debugLog";

type PanelShellProps = {
	children: ReactNode;
};

export function PanelShell({ children }: PanelShellProps) {
	const [size, setSize] = useState(() => ({
		width: window.innerWidth,
		height: window.innerHeight,
	}));

	useEffect(() => {
		const update = (reason: string) => {
			const next = { width: window.innerWidth, height: window.innerHeight };
			setSize((current) => {
				if (current.width === next.width && current.height === next.height) {
					return current;
				}
				debugLog("panel-shell", "Dimensions updated", { reason, ...next });
				return next;
			});
		};

		update("mount");
		const onResize = () => update("resize");
		window.addEventListener("resize", onResize);

		const observer =
			typeof ResizeObserver !== "undefined"
				? new ResizeObserver(() => update("resize-observer"))
				: null;
		observer?.observe(document.documentElement);
		observer?.observe(document.body);

		return () => {
			window.removeEventListener("resize", onResize);
			observer?.disconnect();
		};
	}, []);

	return (
		<div
			className="flex min-h-0 flex-1 flex-col overflow-hidden"
			style={{ minHeight: size.height > 0 ? undefined : "100vh" }}
		>
			{children}
		</div>
	);
}