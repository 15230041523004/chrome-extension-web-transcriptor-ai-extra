// MUST be first: configure ONNX Runtime to use local WASM
import "./ort-env-bootstrap";

import React from "react";
import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "./globals.css";
import {
	DEFAULT_TRANSCRIPTION_SETTINGS,
	MODEL_IDS,
	type TranscriptionSettings,
	type WhisperModel,
} from "./jotai/transcriptionSettings";
import { extractNewAudioSegment, MIN_FLUSH_AUDIO_SAMPLES } from "./lib/incrementalAudio";
import { normalizeModelProgress } from "./lib/modelProgress";
import {
	initializeWhisperWorker,
	processWhisperMessage,
} from "./whisper-worker.js";

const WHISPER_SAMPLING_RATE = 16_000;
const MAX_AUDIO_LENGTH = 30;
const MAX_SAMPLES = WHISPER_SAMPLING_RATE * MAX_AUDIO_LENGTH;
const MIN_NEW_AUDIO_SECONDS = 1;
const MIN_NEW_AUDIO_SAMPLES = WHISPER_SAMPLING_RATE * MIN_NEW_AUDIO_SECONDS;

const getRecommendedModel = (): WhisperModel => "base";

const resolveModelId = (whisperModel: WhisperModel): string => {
	const model = whisperModel === "auto" ? getRecommendedModel() : whisperModel;
	return MODEL_IDS[model];
};

export const Offscreen: React.FC = () => {
	const settingsRef = useRef<TranscriptionSettings>(DEFAULT_TRANSCRIPTION_SETTINGS);
	const recorderRef = React.useRef<MediaRecorder | null>(null);
	const [recording, setRecording] = useState(false);
	const audioContextRef = React.useRef<AudioContext | null>(null);
	const [chunks, setChunks] = useState<Blob[]>([]);
	const modelLoadedRef = React.useRef(false);
	const loadedModelIdRef = React.useRef<string | null>(null);
	const micStreamRef = React.useRef<MediaStream | null>(null);
	const mixContextRef = React.useRef<AudioContext | null>(null);
	const chunksRef = React.useRef<Blob[]>([]);
	const transcribedSamplesRef = React.useRef(0);
	const transcribeBusyRef = React.useRef(false);
	const transcribePendingRef = React.useRef(false);
	const transcribeFlushRef = React.useRef(false);
	const transcribeLatestAudioRef = React.useRef<(options?: { flush?: boolean }) => Promise<void>>(
		async () => {},
	);

	const applySettings = (settings: TranscriptionSettings) => {
		settingsRef.current = settings;
	};

	const stopActiveRecorder = () => {
		if (recorderRef.current?.state === "recording") {
			recorderRef.current.stop();
		}
		recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
		recorderRef.current = null;
		micStreamRef.current?.getTracks().forEach((track) => track.stop());
		micStreamRef.current = null;
		mixContextRef.current?.close();
		mixContextRef.current = null;
		audioContextRef.current?.close();
		audioContextRef.current = null;
		setRecording(false);
		setChunks([]);
		chunksRef.current = [];
		transcribedSamplesRef.current = 0;
		transcribePendingRef.current = false;
		transcribeFlushRef.current = false;
	};

	const setupMediaRecorder = async (streamId: string) => {
		stopActiveRecorder();

		const includeMicrophone = settingsRef.current.includeMicrophone ?? false;

		try {
			const tabStream = await navigator.mediaDevices.getUserMedia({
				audio: {
					// @ts-expect-error - Chrome-specific tab capture properties
					mandatory: {
						chromeMediaSource: "tab",
						chromeMediaSourceId: streamId,
					},
				},
			});

			let streamToRecord: MediaStream;

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
					streamToRecord = tabStream;
				}
			} else {
				streamToRecord = tabStream;
			}

			recorderRef.current = new MediaRecorder(streamToRecord);
			audioContextRef.current = new AudioContext({ sampleRate: 16000 });

			const output = new AudioContext();
			const source = output.createMediaStreamSource(recorderRef.current.stream);
			source.connect(output.destination);

			recorderRef.current.onstart = () => {
				setRecording(true);
				setChunks([]);
				chunksRef.current = [];
				transcribedSamplesRef.current = 0;
				transcribePendingRef.current = false;
				transcribeFlushRef.current = false;
				chrome.runtime.sendMessage({ type: "recording-state", data: { recording: true } });
			};

			recorderRef.current.ondataavailable = (e) => {
				if (e.data.size > 0) {
					setChunks((prev) => {
						const next = [...prev, e.data];
						chunksRef.current = next;
						return next;
					});
					setTimeout(() => recorderRef.current?.requestData(), 10_000);
				} else {
					setTimeout(() => recorderRef.current?.requestData(), 25);
				}
			};

			recorderRef.current.onstop = () => {
				setRecording(false);
				chrome.runtime.sendMessage({ type: "recording-state", data: { recording: false } });
				void transcribeLatestAudioRef.current({ flush: true });
			};

			recorderRef.current.start();
		} catch (err) {
			console.error("Setup error:", err);
		}
	};

	const transcribeLatestAudio = React.useCallback(async (options?: { flush?: boolean }) => {
		if (!recorderRef.current || !audioContextRef.current) return;
		if (options?.flush) transcribeFlushRef.current = true;
		if (transcribeBusyRef.current) {
			transcribePendingRef.current = true;
			return;
		}

		transcribeBusyRef.current = true;

		try {
			do {
				transcribePendingRef.current = false;

				const currentChunks = chunksRef.current;
				if (currentChunks.length === 0) break;

				const blob = new Blob(currentChunks, { type: recorderRef.current.mimeType });
				const arrayBuffer = await blob.arrayBuffer();
				const decoded = await audioContextRef.current.decodeAudioData(arrayBuffer.slice(0));
				const fullAudio = decoded.getChannelData(0);

				const minNewSamples = transcribeFlushRef.current
					? MIN_FLUSH_AUDIO_SAMPLES
					: MIN_NEW_AUDIO_SAMPLES;

				const segment = extractNewAudioSegment(
					fullAudio,
					transcribedSamplesRef.current,
					MAX_SAMPLES,
					minNewSamples,
				);
				if (!segment) break;

				const settings = settingsRef.current;
				const modelId = resolveModelId(settings.whisperModel);

				if (!modelLoadedRef.current || loadedModelIdRef.current !== modelId) {
					modelLoadedRef.current = false;
					loadedModelIdRef.current = modelId;
					chrome.runtime.sendMessage({ type: "model-status", data: { status: "loading", progress: 0 } });
					await initializeWhisperWorker((progress) => {
						chrome.runtime.sendMessage({
							type: "model-status",
							data: { status: "loading", progress: normalizeModelProgress(progress) },
						});
					}, modelId);
					modelLoadedRef.current = true;
					chrome.runtime.sendMessage({ type: "model-status", data: { status: "ready" } });
				}

				const { mode, transcribeLanguage } = settings;
				const task = mode === "translate" ? "translate" : "transcribe";
				const language = mode === "transcribe" ? transcribeLanguage : null;

				const transcripted = await processWhisperMessage(
					segment.newAudio,
					language,
					task,
					modelId,
				);

				transcribedSamplesRef.current = segment.totalSamples;

				const text = transcripted?.join("\n").trim();
				if (text) {
					chrome.runtime.sendMessage({
						type: "transcript",
						data: { transcripted: text },
					});
				}
			} while (transcribePendingRef.current);

		} catch (err) {
			console.error("Transcription failed:", err);
			chrome.runtime.sendMessage({ type: "model-status", data: { status: "error" } });
		} finally {
			transcribeBusyRef.current = false;
			if (!transcribePendingRef.current) {
				transcribeFlushRef.current = false;
			}
		}
	}, []);

	transcribeLatestAudioRef.current = transcribeLatestAudio;

	useEffect(() => {
		if (!recorderRef.current) return;
		if (!recording) return;

		if (chunks.length > 0) {
			void transcribeLatestAudio();
		} else {
			recorderRef.current?.requestData();
		}
	}, [recording, chunks, transcribeLatestAudio]);

	useEffect(() => {
		const onMessage = (message: {
			target?: string;
			type?: string;
			streamId?: string;
			settings?: TranscriptionSettings;
		}) => {
			if (message.target !== "offscreen") return;

			if (message.type === "prepare-capture" || message.type === "stop-recording") {
				stopActiveRecorder();
				if (message.type === "stop-recording") {
					chrome.runtime.sendMessage({ type: "recording-state", data: { recording: false } });
				}
				return;
			}

			if (message.type === "start-recording" && message.streamId) {
				if (message.settings) {
					applySettings(message.settings);
				}
				void setupMediaRecorder(message.streamId);
			}
		};

		chrome.runtime.onMessage.addListener(onMessage);

		return () => {
			chrome.runtime.onMessage.removeListener(onMessage);
		};
	}, []);

	return <div><h1>Offscreen Document</h1></div>;
};

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<Offscreen />
	</React.StrictMode>,
);