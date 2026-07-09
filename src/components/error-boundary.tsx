import { Component, type ErrorInfo, type ReactNode } from "react";
import { debugError } from "@/lib/debugLog";
import { DebugPanel } from "./debug-panel";

type ErrorBoundaryProps = {
	children: ReactNode;
};

type ErrorBoundaryState = {
	error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		debugError("error-boundary", "React render error", {
			message: error.message,
			stack: error.stack,
			componentStack: info.componentStack,
		});
	}

	render() {
		if (this.state.error) {
			return (
				<div className="flex h-full min-h-screen flex-col bg-background text-sm text-foreground">
					<div className="flex flex-col gap-2 p-4">
						<p className="font-semibold">Side panel failed to load</p>
						<p className="text-xs text-muted-foreground">{this.state.error.message}</p>
						<p className="text-xs text-muted-foreground">
							Open the <strong>bug icon</strong> in the corner, copy the full log, and send it to support.
						</p>
						<button
							type="button"
							className="w-fit rounded-md border border-border px-3 py-2 text-xs"
							onClick={() => window.location.reload()}
						>
							Reload panel
						</button>
					</div>
					<DebugPanel />
				</div>
			);
		}

		return this.props.children;
	}
}