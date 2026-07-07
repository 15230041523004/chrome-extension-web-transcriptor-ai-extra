const hasChromeLocalStorage = (): boolean =>
	typeof chrome !== "undefined" && !!chrome.storage?.local;

export function createExtensionStorage<T>() {
	return {
		getItem: (key: string, initialValue: T): Promise<T> =>
			new Promise((resolve) => {
				if (hasChromeLocalStorage()) {
					chrome.storage.local.get(key, (result) => {
						if (chrome.runtime.lastError || result[key] === undefined) {
							resolve(initialValue);
							return;
						}
						resolve(result[key] as T);
					});
					return;
				}

				try {
					const stored = localStorage.getItem(key);
					if (!stored) {
						resolve(initialValue);
						return;
					}
					resolve(JSON.parse(stored) as T);
				} catch {
					resolve(initialValue);
				}
			}),

		setItem: (key: string, value: T): Promise<void> =>
			new Promise((resolve) => {
				if (hasChromeLocalStorage()) {
					chrome.storage.local.set({ [key]: value }, () => resolve());
					return;
				}

				localStorage.setItem(key, JSON.stringify(value));
				resolve();
			}),

		removeItem: (key: string): Promise<void> =>
			new Promise((resolve) => {
				if (hasChromeLocalStorage()) {
					chrome.storage.local.remove(key, () => resolve());
					return;
				}

				localStorage.removeItem(key);
				resolve();
			}),
	};
}

export function readChromeLocalValue<T>(key: string, initialValue: T): Promise<T> {
	return createExtensionStorage<T>().getItem(key, initialValue);
}