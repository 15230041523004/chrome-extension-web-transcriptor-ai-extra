// assets/background.js - Fixed version
// Исправлена ошибка "Failed to get stream ID" и обработка ошибок

const BLOCKED_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "about:",
  "edge://",
  "brave://",
  "moz-extension://"
];

function isCapturableUrl(url) {
  if (!url) return false;
  return !BLOCKED_PREFIXES.some(prefix => url.startsWith(prefix));
}

let isRecording = false;
let pendingTabId = null;

async function startCapture() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      chrome.runtime.sendMessage({
        type: "capture-error",
        data: { error: "Нет активной вкладки. Откройте обычный сайт (YouTube, статья и т.д.)" }
      });
      return;
    }

    if (!isCapturableUrl(tab.url)) {
      chrome.runtime.sendMessage({
        type: "capture-error",
        data: {
          error: "Нельзя захватывать внутренние страницы Chrome (chrome://, about:, расширения). Откройте обычный сайт."
        }
      });
      return;
    }

    // Запрашиваем stream ID
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        const errorMsg = chrome.runtime.lastError?.message || "Не удалось получить доступ к аудио вкладки";
        chrome.runtime.sendMessage({
          type: "capture-error",
          data: { error: errorMsg }
        });
        return;
      }

      console.log("[Background] Stream ID получен:", streamId);

      // Отправляем в offscreen document
      chrome.runtime.sendMessage({
        type: "start-recording",
        target: "offscreen",
        streamId: streamId
      });

      isRecording = true;
      pendingTabId = tab.id;
    });

  } catch (err) {
    console.error("[Background] Ошибка захвата:", err);
    chrome.runtime.sendMessage({
      type: "capture-error",
      data: { error: err.message || String(err) }
    });
  }
}

function stopCapture() {
  chrome.runtime.sendMessage({
    type: "stop-recording",
    target: "offscreen"
  });
  isRecording = false;
  pendingTabId = null;
}

// Обработчик сообщений
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Background] Получено сообщение:", message.type);

  if (message.type === "start-transcription") {
    startCapture();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "stop-transcription") {
    stopCapture();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "get-recording-state") {
    sendResponse({ recording: isRecording });
    return true;
  }

  if (message.type === "recording-state") {
    isRecording = message.data?.recording ?? false;
    // Пересылаем в side panel
    chrome.runtime.sendMessage({
      type: "recording-state",
      data: { recording: isRecording }
    });
    return true;
  }

  if (message.type === "offscreen-ready") {
    if (pendingTabId) {
      pendingTabId = null;
    }
    return true;
  }

  return false;
});

// Обработка закрытия вкладки
chrome.tabs.onRemoved.addListener((tabId) => {
  if (pendingTabId === tabId) {
    pendingTabId = null;
  }
});

console.log("[Background] Service worker запущен");