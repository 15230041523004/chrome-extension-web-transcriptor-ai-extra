// ... existing imports and component ...

	const [captureError, setCaptureError] = useState<string | null>(null);

	useEffect(() => {
		// ... existing messageListener ...
		const messageListener = (message: any) => {
			if (message.type === "capture-error") {
				setCaptureError(message.data?.error || "Неизвестная ошибка захвата");
				setTimeout(() => setCaptureError(null), 6000); // auto-hide after 6s
			}
			// ... rest of existing listeners ...
		};
		chrome.runtime.onMessage.addListener(messageListener);
		return () => chrome.runtime.onMessage.removeListener(messageListener);
	}, []);

	// ... rest of component ...

	return (
		<div className="container">
			{/* ... existing UI ... */}

			{captureError && (
				<div className="mx-2 mb-2 p-3 bg-red-900/30 border border-red-700 rounded text-sm text-red-200">
					{captureError}
				</div>
			)}

			{/* ... rest of UI ... */}
		</div>
	);
};
