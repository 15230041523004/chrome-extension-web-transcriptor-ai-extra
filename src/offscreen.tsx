// MUST be first: configure ONNX Runtime to use local WASM
import "./ort-env-bootstrap";

import React from "react";
import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import "./globals.css";
import { useAtom } from "jotai";
import { transcriptionSettingsAtom } from "./jotai/settingAtom";
import {
	initializeWhisperWorker,
	processWhisperMessage,
} from "./whisper-worker.js";

const WHISPER_SAMPLING_RATE = 16_000;
const MAX_AUDIO_LENGTH = 30;
const MAX_SAMPLES = WHISPER_SAMPLING_RATE * MAX_AUDIO_LENGTH;

export const Offscreen: React.FC = () => {
	const [transcriptionSettings] = useAtom(transcriptionSettingsAtom);
	const recorderRef = React.useRef<MediaRecorder | null>(null);
	const [recording, setRecording] = React.useState(false);
	const audioContextRef = React.useRef<AudioContext | null>(null);
	const [chunks, setChunks] = React.useState<Blob[]>([]);
	const modelLoadedRef = React.useRef(false);
	const micStreamRef = React.useRef<MediaStream | null>(null);
	const mixContextRef = React.useRef<AudioContext | null>(null);

	const setupMediaRecorder = async (streamId: string) => {
		if (recorderRef.current) return;

		const includeMicrophone = transcriptionSettings.includeMicrophone ?? false;

		try {
			// @ts-ignore - Chrome specific tab capture API (mandatory is not in standard types)
			const tabStream = await navigator.mediaDevices.getUserMedia({
				audio: {
					mandatory: {
						chromeMediaSource: "tab",
						chromeMediaSourceId: streamId,
					},
				},
			});

			let streamToRecord = tabStream;

			if (includeMicrophone) {
				try {
					const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
					micStreamRef.current = micStream;

					const mixContext = new AudioContext({ sampleRate: 16000 });
					const destination = mixContext.createMediaStreamDestination();

					const tabSource = mixContext.createMediaStreamSource(tabStream);
					const micSource = mixContext.createMediaStreamSource(micStream);

					tabSource.connect(destination);
					micSource.connect(destination);

					streamToRecord = destination.stream;
					mixContextRef.current = mixContext;
				} catch (micErr) {
					console.warn("Microphone access denied, using tab audio only:", micErr);
				}
			}

			recorderRef.current = new MediaRecorder(streamToRecord);
			audioContextRef.current = new AudioContext({ sampleRate: 16000 });

			recorderRef.current.onstart = () => {
				setRecording(true);
				setChunks([]);
				chrome.runtime.sendMessage({ type: "recording-state", data: { recording: true } });
			};

			recorderRef.current.ondataavailable = (e) => {
				if (e.data.size > 0) {
					setChunks((prev) => [...prev, e.data]);
					setTimeout(() => recorderRef.current?.requestData(), 10000);
				} else {
					setTimeout(() => recorderRef.current?.requestData(), 25);
				}
			};

			recorderRef.current.onstop = () => {
				setRecording(false);
				chrome.runtime.sendMessage({ type: "recording-state", data: { recording: false } });
			};

			recorderRef.current.start();
		} catch (err) {
			console.error("Setup error:", err);
		}
	};

	useEffect(() => {
		if (!recording || chunks.length === 0) return;

		const blob = new Blob(chunks, { type: recorderRef.current?.mimeType });
		const fileReader = new FileReader();

		fileReader.onloadend = async () => {
			const arrayBuffer = fileReader.result as ArrayBuffer;
			if (!arrayBuffer || !audioContextRef.current) return;

			const decoded = await audioContextRef.current.decodeAudioData(arrayBuffer);
			let audio = decoded.getChannelData(0);
			if (audio.length > MAX_SAMPLES) audio = audio.slice(-MAX_SAMPLES);

			const audioFloat32 = new Float32Array(audio);

			try {
				if (!modelLoadedRef.current) {
					chrome.runtime.sendMessage({ type: "model-status", data: { status: "loading", progress: 0 } });
					await initializeWhisperWorker((progress) => {
						chrome.runtime.sendMessage({ type: "model-status", data: { status: "loading", progress } });
					});
					modelLoadedRef.current = true;
					chrome.runtime.sendMessage({ type: "model-status", data: { status: "ready" } });
				}

				const { mode, transcribeLanguage } = transcriptionSettings;
				const task = mode === "translate" ? "translate" : "transcribe";
				// Force Russian for transcribe mode
				const language = (mode === "transcribe" && transcribeLanguage) ? transcribeLanguage : (transcribeLanguage || "ru");

				const transcripted = await processWhisperMessage(audioFloat32, language, task);

				if (transcripted) {
					chrome.runtime.sendMessage({
						type: "transcript",
						data: { transcripted: transcripted.join("\n") },
					});
				}
			} catch (err) {
				console.error("Transcription failed:", err);
				chrome.runtime.sendMessage({ type: "model-status", data: { status: "error" } });
			}
		};

		fileReader.readAsArrayBuffer(blob);
	}, [recording, chunks, transcriptionSettings]);

	const setupTriggeredRef = React.useRef(false);
	const setupOffscreen = () => {
		if (setupTriggeredRef.current) return;
		setupTriggeredRef.current = true;

		chrome.runtime.onMessage.addListener(async (message) => {
			if (message.target !== "offscreen") return;

			if (message.type === "start-recording") {
				setupMediaRecorder(message.streamId);
			} else if (message.type === "stop-recording") {
				if (recorderRef.current?.state === "recording") {
					recorderRef.current.stop();
					recorderRef.current.stream.getTracks().forEach(track => track.stop());
					recorderRef.current = null;
				}
				micStreamRef.current?.getTracks().forEach(track => track.stop());
				micStreamRef.current = null;
				mixContextRef.current?.close();
				mixContextRef.current = null;
			}
		});

		chrome.runtime.sendMessage({ type: "offscreen-ready" });
	};

	useEffect(() => {
		setupOffscreen();
	});

	return <div><h1>Offscreen Document</h1></div>;
};

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<Offscreen />
	</React.StrictMode>,
);
