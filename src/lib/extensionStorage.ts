const hasChromeLocalStorage = (): boolean =>
	typeof chrome !== "undefined" && !!chrome.storage?.local;

/** chrome.storage callbacks can hang while the service worker is cold. */
const STORAGE_TIMEOUT_MS = 800;

export function createExtensionStorage<T>() {
	return {
		getItem: (key: string, initialValue: T): Promise<T> =>
			new Promise((resolve) => {
				let settled = false;
				const finish = (value: T) => {
					if (settled) return;
					settled = true;
					resolve(value);
				};

				if (hasChromeLocalStorage()) {
					const timer = setTimeout(() => finish(initialValue), STORAGE_TIMEOUT_MS);
					try {
						chrome.storage.local.get(key, (result) => {
							clearTimeout(timer);
							if (chrome.runtime.lastError || result?.[key] === undefined) {
								finish(initialValue);
								return;
							}
							finish(result[key] as T);
						});
					} catch {
						clearTimeout(timer);
						finish(initialValue);
					}
					return;
				}

				try {
					const stored = localStorage.getItem(key);
					if (!stored) {
						finish(initialValue);
						return;
					}
					finish(JSON.parse(stored) as T);
				} catch {
					finish(initialValue);
				}
			}),

		setItem: (key: string, value: T): Promise<void> =>
			new Promise((resolve) => {
				if (hasChromeLocalStorage()) {
					const timer = setTimeout(() => resolve(), STORAGE_TIMEOUT_MS);
					try {
						chrome.storage.local.set({ [key]: value }, () => {
							clearTimeout(timer);
							void chrome.runtime.lastError;
							resolve();
						});
					} catch {
						clearTimeout(timer);
						resolve();
					}
					return;
				}

				localStorage.setItem(key, JSON.stringify(value));
				resolve();
			}),

		removeItem: (key: string): Promise<void> =>
			new Promise((resolve) => {
				if (hasChromeLocalStorage()) {
					const timer = setTimeout(() => resolve(), STORAGE_TIMEOUT_MS);
					try {
						chrome.storage.local.remove(key, () => {
							clearTimeout(timer);
							void chrome.runtime.lastError;
							resolve();
						});
					} catch {
						clearTimeout(timer);
						resolve();
					}
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