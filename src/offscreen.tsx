// MUST be first: configure ONNX Runtime to use local WASM
import "./ort-env-bootstrap";

import React from "react";
import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "./globals.css";
import {
	DEFAULT_TRANSCRIPTION_SETTINGS,
	getLanguageDetectionPriority,
	MODEL_IDS,
	type TranscriptionSettings,
	type WhisperModel,
} from "./jotai/transcriptionSettings";
import { buildPhraseChunks } from "./lib/phraseChunks";
import {
	assignSpeakersByPause,
	initializeSpeakerEmbeddings,
	resetSpeakerEmbeddings,
} from "./lib/speakerEmbeddings";
import { buildSpeakerSegmentsFromAudio, detectSpeechTurns } from "./lib/speechTurns";
import { extractNewAudioSegment, MIN_FLUSH_AUDIO_SAMPLES } from "./lib/incrementalAudio";
import { mergeDiarizationWithTranscript } from "./lib/mergeDiarization";
import { normalizeModelProgress } from "./lib/modelProgress";
import {
	initializeWhisperWorker,
	processWhisperMessage,
	processWhisperWithTimestamps,
} from "./whisper-worker.js";

const WHISPER_SAMPLING_RATE = 16_000;
const MAX_AUDIO_LENGTH = 30;
const MAX_SAMPLES = WHISPER_SAMPLING_RATE * MAX_AUDIO_LENGTH;
const MIN_NEW_AUDIO_SECONDS = 1;
const MIN_NEW_AUDIO_SAMPLES = WHISPER_SAMPLING_RATE * MIN_NEW_AUDIO_SECONDS;
const MIN_DIARIZATION_SAMPLES = WHISPER_SAMPLING_RATE * 3;
const MAX_DIARIZATION_SAMPLES = WHISPER_SAMPLING_RATE * 60 * 10;

const getRecommendedModel = (): WhisperModel => "base";

const resolveModelId = (whisperModel: WhisperModel): string => {
	const model = whisperModel === "auto" ? getRecommendedModel() : whisperModel;
	return MODEL_IDS[model];
};

const resolveTranscriptionLanguage = (settings: TranscriptionSettings) => {
	const language = settings.mode === "transcribe" ? settings.transcribeLanguage : null;
	const languagePriority =
		settings.mode === "transcribe" && settings.transcribeLanguage === null
			? getLanguageDetectionPriority()
			: null;

	return { language, languagePriority };
};

const decodeSessionAudio = async (
	audioContext: AudioContext,
	chunks: Blob[],
	mimeType: string,
): Promise<Float32Array | null> => {
	if (chunks.length === 0) return null;
	const blob = new Blob(chunks, { type: mimeType });
	const arrayBuffer = await blob.arrayBuffer();
	const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
	return new Float32Array(decoded.getChannelData(0));
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
	const mimeTypeRef = React.useRef<string>("");
	const transcribedSamplesRef = React.useRef(0);
	const transcribeBusyRef = React.useRef(false);
	const transcribePendingRef = React.useRef(false);
	const transcribeFlushRef = React.useRef(false);
	const finalizeBusyRef = React.useRef(false);
	const transcribeLatestAudioRef = React.useRef<(options?: { flush?: boolean }) => Promise<void>>(
		async () => {},
	);
	const finalizeRecordingSessionRef = React.useRef<() => Promise<void>>(async () => {});

	const applySettings = (settings: TranscriptionSettings) => {
		settingsRef.current = settings;
	};

	const releaseMediaResources = () => {
		recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
		recorderRef.current = null;
		micStreamRef.current?.getTracks().forEach((track) => track.stop());
		micStreamRef.current = null;
		mixContextRef.current?.close();
		mixContextRef.current = null;
		audioContextRef.current?.close();
		audioContextRef.current = null;
		mimeTypeRef.current = "";
		setRecording(false);
		setChunks([]);
		chunksRef.current = [];
		transcribedSamplesRef.current = 0;
		transcribePendingRef.current = false;
		transcribeFlushRef.current = false;
	};

	const requestStopRecording = () => {
		if (recorderRef.current?.state === "recording") {
			recorderRef.current.stop();
			return;
		}
		releaseMediaResources();
	};

	const sendModelStatus = (data: {
		status: "loading" | "ready" | "error" | "diarizing";
		progress?: number;
		message?: string;
		modelId?: string;
	}) => {
		const modelId = data.modelId ?? loadedModelIdRef.current ?? undefined;
		chrome.runtime.sendMessage({
			type: "model-status",
			data: modelId ? { ...data, modelId } : data,
		});
	};

	const ensureWhisperModel = async (modelId: string) => {
		if (!modelLoadedRef.current || loadedModelIdRef.current !== modelId) {
			modelLoadedRef.current = false;
			loadedModelIdRef.current = modelId;
			sendModelStatus({ status: "loading", progress: 0, modelId });
			await initializeWhisperWorker((progress) => {
				sendModelStatus({
					status: "loading",
					progress: normalizeModelProgress(progress),
					modelId,
				});
			}, modelId);
			modelLoadedRef.current = true;
			sendModelStatus({ status: "ready", modelId });
		}
	};

	const runPostStopDiarization = async (sessionAudio: Float32Array, settings: TranscriptionSettings) => {
		const modelId = resolveModelId(settings.whisperModel);
		sendModelStatus({ status: "diarizing", modelId });
		const task = settings.mode === "translate" ? "translate" : "transcribe";
		const { language, languagePriority } = resolveTranscriptionLanguage(settings);

		await ensureWhisperModel(modelId);

		const transcript = await processWhisperWithTimestamps(
			sessionAudio,
			language,
			task,
			modelId,
			languagePriority,
		);
		if (!transcript) return;

		let segments: Awaited<ReturnType<typeof buildSpeakerSegmentsFromAudio>> = [];
		try {
			await initializeSpeakerEmbeddings((progress) => {
				sendModelStatus({
					status: "diarizing",
					progress: 55 + normalizeModelProgress(progress) * 0.15,
					modelId,
				});
			});

			segments = await buildSpeakerSegmentsFromAudio(sessionAudio, (progress) => {
				sendModelStatus({
					status: "diarizing",
					progress: 70 + normalizeModelProgress(progress) * 0.25,
					modelId,
				});
			});
		} catch (err) {
			console.warn("Speaker segmentation failed, using pause alternation:", err);
			segments = assignSpeakersByPause(detectSpeechTurns(sessionAudio));
		} finally {
			resetSpeakerEmbeddings();
		}

		const phraseChunks = buildPhraseChunks(transcript.chunks);
		const formatted = mergeDiarizationWithTranscript(segments, phraseChunks);
		const fallbackText = transcript.text?.trim() ?? phraseChunks.map((chunk) => chunk.text).join(" ").trim();

		if (formatted.trim()) {
			chrome.runtime.sendMessage({
				type: "transcript-diarized",
				data: { transcripted: formatted },
			});
		} else if (fallbackText) {
			chrome.runtime.sendMessage({
				type: "transcript-diarized",
				data: { transcripted: `Speaker 1: ${fallbackText}` },
			});
		}
	};

	const transcribeLatestAudio = React.useCallback(async (options?: { flush?: boolean }) => {
		const audioContext = audioContextRef.current;
		const mimeType = recorderRef.current?.mimeType ?? mimeTypeRef.current;
		if (!audioContext || !mimeType) return;

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

				const blob = new Blob(currentChunks, { type: mimeType });
				const arrayBuffer = await blob.arrayBuffer();
				const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
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
				await ensureWhisperModel(modelId);

				const task = settings.mode === "translate" ? "translate" : "transcribe";
				const { language, languagePriority } = resolveTranscriptionLanguage(settings);

				const transcripted = await processWhisperMessage(
					segment.newAudio,
					language,
					task,
					modelId,
					languagePriority,
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
			sendModelStatus({ status: "error" });
		} finally {
			transcribeBusyRef.current = false;
			if (!transcribePendingRef.current) {
				transcribeFlushRef.current = false;
			}
		}
	}, []);

	const finalizeRecordingSession = React.useCallback(async () => {
		if (finalizeBusyRef.current) return;
		finalizeBusyRef.current = true;

		setRecording(false);
		chrome.runtime.sendMessage({ type: "recording-state", data: { recording: false } });

		const audioContext = audioContextRef.current;
		const mimeType = recorderRef.current?.mimeType ?? mimeTypeRef.current;
		const sessionChunks = [...chunksRef.current];

		try {
			if (!audioContext || sessionChunks.length === 0 || !mimeType) return;

			const sessionAudio = await decodeSessionAudio(audioContext, sessionChunks, mimeType);
			if (!sessionAudio) return;

			await transcribeLatestAudio({ flush: true });

			const settings = settingsRef.current;
			if (!settings.speakerDetection) return;

			if (sessionAudio.length < MIN_DIARIZATION_SAMPLES) return;

			if (sessionAudio.length > MAX_DIARIZATION_SAMPLES) {
				sendModelStatus({
					status: "error",
					message: "Recording is longer than 10 minutes. Speaker detection was skipped.",
				});
				return;
			}

			await runPostStopDiarization(sessionAudio, settings);
		} catch (err) {
			console.error("Finalize recording failed:", err);
			sendModelStatus({
				status: "error",
				message: String((err as Error)?.message ?? err),
			});
		} finally {
			sendModelStatus({ status: "ready" });
			releaseMediaResources();
			finalizeBusyRef.current = false;
		}
	}, [transcribeLatestAudio]);

	transcribeLatestAudioRef.current = transcribeLatestAudio;
	finalizeRecordingSessionRef.current = finalizeRecordingSession;

	const setupMediaRecorder = async (streamId: string) => {
		requestStopRecording();
		releaseMediaResources();

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
			mimeTypeRef.current = recorderRef.current.mimeType;
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
				void finalizeRecordingSessionRef.current();
			};

			recorderRef.current.start();
		} catch (err) {
			console.error("Setup error:", err);
		}
	};

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

			if (message.type === "prepare-capture") {
				requestStopRecording();
				releaseMediaResources();
				return;
			}

			if (message.type === "stop-recording") {
				requestStopRecording();
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