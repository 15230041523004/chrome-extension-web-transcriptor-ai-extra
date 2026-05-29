// ... existing code ...

	const [captureError, setCaptureError] = useState<string | null>(null);
	const [modelError, setModelError] = useState<string | null>(null);

	useEffect(() => {
		const messageListener = (message: any) => {
			if (message.type === "capture-error") {
				setCaptureError(typeof message.data?.error === "string" ? message.data.error : String(message.data?.error || "Неизвестная ошибка"));
				setTimeout(() => setCaptureError(null), 8000);
			}
			if (message.type === "model-status" && message.data?.status === "error") {
				setModelError(typeof message.data?.message === "string" ? message.data.message : "Ошибка модели (см. консоль)");
				setTimeout(() => setModelError(null), 8000);
			}
			// ... existing listeners ...
		};
		chrome.runtime.onMessage.addListener(messageListener);
		return () => chrome.runtime.onMessage.removeListener(messageListener);
	}, []);

	// ... in return JSX ...
		{captureError && (
			<div className="mx-2 mb-2 p-3 bg-red-900/30 border border-red-700 rounded text-sm text-red-200">
				{captureError}
			</div>
		)}
		{modelError && (
			<div className="mx-2 mb-2 p-3 bg-orange-900/30 border border-orange-700 rounded text-sm text-orange-200">
				{modelError}
			</div>
		)}
// ... rest of UI ...
