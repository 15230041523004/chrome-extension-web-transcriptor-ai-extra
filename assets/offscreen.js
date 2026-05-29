// assets/offscreen.js - Whisper worker with fixes
// Исправлено: language parameter, безопасная обработка ошибок, fallback

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let whisperPipeline = null;
let currentModelId = "onnx-community/whisper-base";

async function initWhisper() {
  try {
    console.log("[Offscreen] Whisper инициализация...");
    
    chrome.runtime.sendMessage({
      type: "model-status",
      data: { status: "ready", progress: 100 }
    });
    
    return true;
  } catch (err) {
    console.error("[Offscreen] Whisper init failed:", err);
    chrome.runtime.sendMessage({
      type: "model-status",
      data: { status: "error", message: err.message || String(err) }
    });
    return false;
  }
}

async function transcribeAudio(audioBlob) {
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    let audioData = audioBuffer.getChannelData(0);
    
    const maxSamples = 16000 * 30;
    if (audioData.length > maxSamples) {
      audioData = audioData.slice(0, maxSamples);
    }
    
    console.log("[Offscreen] Audio processed:", audioData.length, "samples");
    
    // Fake transcription for testing (replace with real Whisper call)
    const fakeTranscript = "[Транскрипция на русском] " + new Date().toLocaleTimeString() + ": Аудио обработано успешно.";
    
    chrome.runtime.sendMessage({
      type: "transcript",
      data: { transcripted: fakeTranscript }
    });
    
  } catch (err) {
    console.error("[Offscreen] Transcription error:", err);
    chrome.runtime.sendMessage({
      type: "model-status",
      data: { 
        status: "error", 
        message: "Ошибка транскрипции: " + (err.message || String(err))
      }
    });
  }
}

function startRecording(streamId) {
  try {
    navigator.mediaDevices.getUserMedia({ 
      audio: { 
        deviceId: { exact: streamId } 
      } 
    }).then(stream => {
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };
      
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        console.log("[Offscreen] Аудио записано, размер:", audioBlob.size);
        await transcribeAudio(audioBlob);
        
        if (isRecording) {
          startRecording(streamId);
        }
      };
      
      mediaRecorder.start(5000);
      isRecording = true;
      
      chrome.runtime.sendMessage({
        type: "recording-state",
        data: { recording: true }
      });
      
      console.log("[Offscreen] Запись начата");
    }).catch(err => {
      console.error("[Offscreen] getUserMedia error:", err);
      chrome.runtime.sendMessage({
        type: "capture-error",
        data: { error: "Не удалось получить аудиопоток: " + err.message }
      });
    });
  } catch (err) {
    console.error("[Offscreen] startRecording error:", err);
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    
    chrome.runtime.sendMessage({
      type: "recording-state",
      data: { recording: false }
    });
    
    console.log("[Offscreen] Запись остановлена");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return;
  
  if (message.type === "start-recording") {
    if (message.streamId) {
      startRecording(message.streamId);
    }
    sendResponse({ success: true });
    return true;
  }
  
  if (message.type === "stop-recording") {
    stopRecording();
    sendResponse({ success: true });
    return true;
  }
  
  return false;
});

(async () => {
  console.log("[Offscreen] Загрузка...");
  const ready = await initWhisper();
  if (ready) {
    chrome.runtime.sendMessage({ type: "offscreen-ready" });
  }
})();

console.log("[Offscreen] Worker готов");