// IMPORTANT: Do NOT import whisper/onnx/transformers at the top level.
// chrome.offscreen.createDocument waits for the document load event, and a top-level
// import of the ML stack (~20MB+ WASM) blocks first launch for tens of seconds.
// Capture must start immediately; load models lazily after recording begins.
import React from "react";
import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
	DEFAULT_TRANSCRIPTION_SETTINGS,
	getLanguageDetectionPriority,
	MODEL_IDS,
	type TranscriptionSettings,
	type WhisperModel,
} from "./jotai/transcriptionSettings";
import { buildPhraseChunks } from "./lib/phraseChunks";
import {
	extractNewAudioSegment,
	MIN_FLUSH_AUDIO_SAMPLES,
} from "./lib/incrementalAudio";
import { mergeDiarizationWithTranscript } from "./lib/mergeDiarization";
import { normalizeModelProgress } from "./lib/modelProgress";
import { safeRuntimeSendMessage } from "./lib/runtimeMessaging";

type WhisperApi = typeof import("./whisper-worker.js");

let whisperApiPromise: Promise<WhisperApi> | null = null;

const loadWhisperApi = async (): Promise<WhisperApi> => {
	if (!whisperApiPromise) {
		whisperApiPromise = (async () => {
			// Configure ORT before transformers is evaluated.
			await import("./ort-env-bootstrap");
			return import("./whisper-worker.js");
		})();
	}
	return whisperApiPromise;
};

const WHISPER_SAMPLING_RATE = 16_000;
const MAX_AUDIO_LENGTH = 30;
const MAX_SAMPLES = WHISPER_SAMPLING_RATE * MAX_AUDIO_LENGTH;
const MIN_NEW_AUDIO_SECONDS = 1;
const MIN_NEW_AUDIO_SAMPLES = WHISPER_SAMPLING_RATE * MIN_NEW_AUDIO_SECONDS;
const MIN_DIARIZATION_SAMPLES = WHISPER_SAMPLING_RATE * 3;
const MAX_DIARIZATION_SAMPLES = WHISPER_SAMPLING_RATE * 60 * 10;

type LiveCaptureResources = {
	generation: number;
	captureId: string;
	recorder: MediaRecorder | null;
	tabStream: MediaStream | null;
	micStream: MediaStream | null;
	mixContext: AudioContext | null;
	monitorContext: AudioContext | null;
};

type CaptureSession = {
	generation: number;
	captureId: string;
	recorder: MediaRecorder;
	chunks: Blob[];
	mimeType: string;
	audioContext: AudioContext;
	transcribedSamples: number;
	settings: TranscriptionSettings;
	processingTail: Promise<void>;
	stopping: boolean;
	finalizeQueued: boolean;
};

type StopRecordingAck = {
	ok: true;
	captureId: string | null;
	generation: number;
	pendingSetupCount: number;
	pendingMediaRequestCount: number;
	pendingTabMediaRequestCount: number;
	liveTracksEnded: boolean;
	wasRecording: boolean;
};

type ResourceReleaseResult = {
	liveTracksEnded: boolean;
	stoppedTracks: number;
};

type SetupAttempt = {
	generation: number;
	captureId: string;
	cancelled: boolean;
	cancelReason: string | null;
	cancelPromise: Promise<string>;
	cancel: (reason: string) => void;
};

type PendingMediaRequest = {
	requestId: number;
	generation: number;
	captureId: string;
	kind: "tab" | "microphone";
	timedOut: boolean;
};

class MediaRequestTimeoutError extends Error {
	readonly kind: PendingMediaRequest["kind"];

	constructor(kind: PendingMediaRequest["kind"], timeoutMs: number) {
		super(`${kind} getUserMedia did not settle within ${timeoutMs}ms`);
		this.name = "MediaRequestTimeoutError";
		this.kind = kind;
	}
}

class SetupCancelledError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "SetupCancelledError";
	}
}

const TAB_MEDIA_REQUEST_TIMEOUT_MS = 8_000;
const MICROPHONE_MEDIA_REQUEST_TIMEOUT_MS = 5_000;

const countPendingTabMediaRequests = (
	requests: Iterable<PendingMediaRequest>,
): number => [...requests].filter((request) => request.kind === "tab").length;

const getRecommendedModel = (): WhisperModel => "base";

const resolveModelId = (whisperModel: WhisperModel): string => {
	const model = whisperModel === "auto" ? getRecommendedModel() : whisperModel;
	return MODEL_IDS[model];
};

const resolveTranscriptionLanguage = (settings: TranscriptionSettings) => {
	const language =
		settings.mode === "transcribe" ? settings.transcribeLanguage : null;
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
	const settingsRef = useRef<TranscriptionSettings>(
		DEFAULT_TRANSCRIPTION_SETTINGS,
	);
	const recorderRef = React.useRef<MediaRecorder | null>(null);
	const liveCaptureResourcesRef = React.useRef<LiveCaptureResources | null>(
		null,
	);
	const activeSessionRef = React.useRef<CaptureSession | null>(null);
	const captureGenerationRef = React.useRef(0);
	const pendingSetupsRef = React.useRef(new Map<number, SetupAttempt>());
	const pendingMediaRequestsRef = React.useRef(
		new Map<number, PendingMediaRequest>(),
	);
	const mediaRequestSequenceRef = React.useRef(0);
	const [recording, setRecording] = useState(false);
	const recordingRef = useRef(false);
	const [chunks, setChunks] = useState<Blob[]>([]);
	const modelLoadedRef = React.useRef(false);
	const loadedModelIdRef = React.useRef<string | null>(null);
	const analysisQueueRef = React.useRef<Promise<void>>(Promise.resolve());
	const transcribeLatestAudioRef = React.useRef<() => Promise<void>>(
		async () => {},
	);
	const finalizeRecordingSessionRef = React.useRef<
		(session: CaptureSession) => Promise<void>
	>(async () => {});
	const requestStopRecordingRef = React.useRef<
		(reason: string, notifyBackground?: boolean) => StopRecordingAck
	>(() => ({
		ok: true,
		captureId: null,
		generation: 0,
		pendingSetupCount: 0,
		pendingMediaRequestCount: 0,
		pendingTabMediaRequestCount: 0,
		liveTracksEnded: true,
		wasRecording: false,
	}));
	const setupMediaRecorderRef = React.useRef<
		(streamId: string, captureId: string) => Promise<void>
	>(async () => {});

	const emitCaptureLifecycle = (
		event: string,
		detail: Record<string, unknown> = {},
	) => {
		safeRuntimeSendMessage({
			type: "offscreen-capture-lifecycle",
			data: {
				event,
				generation: captureGenerationRef.current,
				pendingSetupCount: pendingSetupsRef.current.size,
				pendingMediaRequestCount: pendingMediaRequestsRef.current.size,
				pendingTabMediaRequestCount: countPendingTabMediaRequests(
					pendingMediaRequestsRef.current.values(),
				),
				...detail,
			},
		});
	};

	const closeAudioContext = (context: AudioContext | null): void => {
		if (!context) return;
		void context.close().catch(() => {
			// Context may already be closed by Chrome during offscreen teardown.
		});
	};

	const stopStreamTracks = (stream: MediaStream | null): number => {
		if (!stream) return 0;
		let stopped = 0;
		for (const track of stream.getTracks()) {
			if (track.readyState !== "ended") {
				track.stop();
				stopped += 1;
			}
		}
		return stopped;
	};

	const releaseOwnedCaptureResources = (
		resources: LiveCaptureResources,
		reason: string,
		notifyBackground: boolean,
	): ResourceReleaseResult => {
		const wasCurrent = liveCaptureResourcesRef.current === resources;
		const streams = new Set<MediaStream>();
		if (resources.tabStream) streams.add(resources.tabStream);
		if (resources.micStream) streams.add(resources.micStream);
		if (resources.recorder?.stream) streams.add(resources.recorder.stream);

		let stoppedTracks = 0;
		for (const stream of streams) {
			stoppedTracks += stopStreamTracks(stream);
		}
		const liveTracksEnded = [...streams].every((stream) =>
			stream.getTracks().every((track) => track.readyState === "ended"),
		);

		closeAudioContext(resources.mixContext);
		closeAudioContext(resources.monitorContext);
		resources.tabStream = null;
		resources.micStream = null;
		resources.mixContext = null;
		resources.monitorContext = null;

		if (recorderRef.current === resources.recorder) {
			recorderRef.current = null;
		}
		resources.recorder = null;
		if (wasCurrent) {
			liveCaptureResourcesRef.current = null;
			recordingRef.current = false;
			setRecording(false);
			if (notifyBackground) {
				safeRuntimeSendMessage({
					type: "recording-state",
					data: { recording: false, captureId: resources.captureId },
				});
			}
		}

		emitCaptureLifecycle("tracks-released", {
			captureId: resources.captureId,
			reason,
			resourceGeneration: resources.generation,
			stoppedTracks,
			liveTracksEnded,
			wasCurrent,
		});
		return { liveTracksEnded, stoppedTracks };
	};

	const requestStopRecording = (
		reason: string,
		notifyBackground = true,
	): StopRecordingAck => {
		const pendingSetupCount = pendingSetupsRef.current.size;
		const pendingMediaRequestCount = pendingMediaRequestsRef.current.size;
		const pendingTabMediaRequestCount = countPendingTabMediaRequests(
			pendingMediaRequestsRef.current.values(),
		);
		const generation = captureGenerationRef.current + 1;
		captureGenerationRef.current = generation;
		for (const attempt of pendingSetupsRef.current.values()) {
			attempt.cancel(reason);
		}

		const resources = liveCaptureResourcesRef.current;
		const recorder = resources?.recorder ?? recorderRef.current;
		const session = activeSessionRef.current;
		const pendingSetup = pendingSetupsRef.current.values().next().value as
			| SetupAttempt
			| undefined;
		const pendingMediaRequest = pendingMediaRequestsRef.current.values().next()
			.value as PendingMediaRequest | undefined;
		const captureId =
			resources?.captureId ??
			session?.captureId ??
			pendingSetup?.captureId ??
			pendingMediaRequest?.captureId ??
			null;
		const wasRecording =
			recordingRef.current ||
			recorder?.state === "recording" ||
			recorder?.state === "paused";
		if (session) {
			session.stopping = true;
			if (activeSessionRef.current === session) {
				activeSessionRef.current = null;
			}
		}

		emitCaptureLifecycle("stop-requested", {
			captureId,
			reason,
			pendingSetupCount,
			recorderState: recorder?.state ?? "none",
		});

		const recorderWasInactive = !recorder || recorder.state === "inactive";
		if (recorder && !recorderWasInactive) {
			try {
				recorder.requestData();
			} catch {
				// No final data is available yet.
			}
			try {
				recorder.stop();
			} catch {
				// Recorder may have transitioned to inactive between checks.
			}
		}

		const releaseResult = resources
			? releaseOwnedCaptureResources(resources, reason, notifyBackground)
			: { liveTracksEnded: true, stoppedTracks: 0 };
		if (!resources) {
			recorderRef.current = null;
			recordingRef.current = false;
			setRecording(false);
			if (notifyBackground) {
				safeRuntimeSendMessage({
					type: "recording-state",
					data: { recording: false, captureId },
				});
			}
		}

		if (session && recorderWasInactive) {
			void finalizeRecordingSessionRef.current(session);
		} else if (session) {
			setTimeout(() => {
				if (!session.finalizeQueued) {
					void finalizeRecordingSessionRef.current(session);
				}
			}, 1000);
		}

		return {
			ok: true,
			captureId,
			generation,
			pendingSetupCount,
			pendingMediaRequestCount,
			pendingTabMediaRequestCount,
			liveTracksEnded:
				releaseResult.liveTracksEnded && pendingMediaRequestCount === 0,
			wasRecording,
		};
	};

	const lastModelStatusRef = useRef<{
		status: string;
		progress: number;
		sentAt: number;
	}>({ status: "", progress: -1, sentAt: 0 });

	const sendModelStatus = (data: {
		status: "loading" | "ready" | "error" | "diarizing";
		progress?: number;
		message?: string;
		modelId?: string;
	}) => {
		const progress =
			typeof data.progress === "number" && Number.isFinite(data.progress)
				? Math.min(100, Math.max(0, Math.round(data.progress)))
				: undefined;
		const now = Date.now();
		const last = lastModelStatusRef.current;
		const isTerminal = data.status === "ready" || data.status === "error";
		const progressDelta =
			progress === undefined || last.progress < 0
				? 100
				: Math.abs(progress - last.progress);

		// Throttle loading/diarizing progress spam (was filling the 500-entry debug log).
		if (
			!isTerminal &&
			data.status === last.status &&
			progressDelta < 5 &&
			now - last.sentAt < 250
		) {
			return;
		}

		lastModelStatusRef.current = {
			status: data.status,
			progress: progress ?? last.progress,
			sentAt: now,
		};

		const modelId = data.modelId ?? loadedModelIdRef.current ?? undefined;
		const payload = {
			...data,
			...(progress !== undefined ? { progress } : {}),
			...(modelId ? { modelId } : {}),
		};
		safeRuntimeSendMessage({
			type: "model-status",
			data: payload,
		});
	};

	const ensureWhisperModel = async (modelId: string) => {
		if (!modelLoadedRef.current || loadedModelIdRef.current !== modelId) {
			modelLoadedRef.current = false;
			loadedModelIdRef.current = modelId;
			sendModelStatus({ status: "loading", progress: 0, modelId });
			const { initializeWhisperWorker } = await loadWhisperApi();
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

	const processAudioForTranscript = async (
		audio: Float32Array,
		settings: TranscriptionSettings,
	): Promise<void> => {
		const modelId = resolveModelId(settings.whisperModel);
		await ensureWhisperModel(modelId);
		const { processWhisperMessage } = await loadWhisperApi();
		const task = settings.mode === "translate" ? "translate" : "transcribe";
		const { language, languagePriority } =
			resolveTranscriptionLanguage(settings);
		const transcripted = await processWhisperMessage(
			audio,
			language,
			task,
			modelId,
			languagePriority,
		);
		const text = transcripted?.join("\n").trim();
		if (text) {
			safeRuntimeSendMessage({
				type: "transcript",
				data: { transcripted: text },
			});
		}
	};

	const runPostStopDiarization = async (
		sessionAudio: Float32Array,
		settings: TranscriptionSettings,
	) => {
		const modelId = resolveModelId(settings.whisperModel);
		sendModelStatus({ status: "diarizing", modelId });
		const task = settings.mode === "translate" ? "translate" : "transcribe";
		const { language, languagePriority } =
			resolveTranscriptionLanguage(settings);

		await ensureWhisperModel(modelId);
		const { processWhisperWithTimestamps } = await loadWhisperApi();

		const transcript = await processWhisperWithTimestamps(
			sessionAudio,
			language,
			task,
			modelId,
			languagePriority,
		);
		if (!transcript) return;

		const {
			assignSpeakersByPause,
			initializeSpeakerEmbeddings,
			resetSpeakerEmbeddings,
		} = await import("./lib/speakerEmbeddings");
		const { buildSpeakerSegmentsFromAudio, detectSpeechTurns } = await import(
			"./lib/speechTurns"
		);

		let segments: Awaited<ReturnType<typeof buildSpeakerSegmentsFromAudio>> =
			[];
		try {
			await initializeSpeakerEmbeddings((progress) => {
				sendModelStatus({
					status: "diarizing",
					progress: 55 + normalizeModelProgress(progress) * 0.15,
					modelId,
				});
			});

			segments = await buildSpeakerSegmentsFromAudio(
				sessionAudio,
				(progress) => {
					sendModelStatus({
						status: "diarizing",
						progress: 70 + normalizeModelProgress(progress) * 0.25,
						modelId,
					});
				},
			);
		} catch (err) {
			console.warn(
				"Speaker segmentation failed, using pause alternation:",
				err,
			);
			segments = assignSpeakersByPause(detectSpeechTurns(sessionAudio));
		} finally {
			resetSpeakerEmbeddings();
		}

		const phraseChunks = buildPhraseChunks(transcript.chunks);
		const formatted = mergeDiarizationWithTranscript(segments, phraseChunks);
		const fallbackText =
			transcript.text?.trim() ??
			phraseChunks
				.map((chunk) => chunk.text)
				.join(" ")
				.trim();

		if (formatted.trim()) {
			safeRuntimeSendMessage({
				type: "transcript-diarized",
				data: { transcripted: formatted },
			});
		} else if (fallbackText) {
			safeRuntimeSendMessage({
				type: "transcript-diarized",
				data: { transcripted: `Speaker 1: ${fallbackText}` },
			});
		}
	};

	const enqueueAnalysis = (task: () => Promise<void>): Promise<void> => {
		const queued = analysisQueueRef.current.then(task, task);
		analysisQueueRef.current = queued.catch(() => {
			// Keep the global ML queue usable after a failed job.
		});
		return queued;
	};

	const enqueueSessionWork = (
		session: CaptureSession,
		task: () => Promise<void>,
	): Promise<void> => {
		const queued = session.processingTail.then(task, task);
		session.processingTail = queued.catch(() => {
			// Keep this session queue usable so finalization can still run.
		});
		return queued;
	};

	const transcribeSessionAudio = async (
		session: CaptureSession,
		minNewSamples: number,
	): Promise<void> => {
		if (session.chunks.length === 0) return;
		const blob = new Blob([...session.chunks], { type: session.mimeType });
		const arrayBuffer = await blob.arrayBuffer();
		const decoded = await session.audioContext.decodeAudioData(
			arrayBuffer.slice(0),
		);
		const segment = extractNewAudioSegment(
			decoded.getChannelData(0),
			session.transcribedSamples,
			MAX_SAMPLES,
			minNewSamples,
		);
		if (!segment) return;

		await enqueueAnalysis(() =>
			processAudioForTranscript(segment.newAudio, session.settings),
		);
		session.transcribedSamples = segment.totalSamples;
	};

	const transcribeLatestAudio = async (): Promise<void> => {
		const session = activeSessionRef.current;
		if (!session || session.stopping) return;

		try {
			await enqueueSessionWork(session, () =>
				transcribeSessionAudio(session, MIN_NEW_AUDIO_SAMPLES),
			);
		} catch (err) {
			console.error("Transcription failed:", err);
			sendModelStatus({ status: "error" });
		}
	};

	const finalizeRecordingSession = async (
		session: CaptureSession,
	): Promise<void> => {
		if (session.finalizeQueued) {
			await session.processingTail;
			return;
		}
		session.finalizeQueued = true;
		session.stopping = true;

		await enqueueSessionWork(session, async () => {
			try {
				if (session.chunks.length === 0 || !session.mimeType) return;
				const sessionAudio = await decodeSessionAudio(
					session.audioContext,
					[...session.chunks],
					session.mimeType,
				);
				if (!sessionAudio) return;

				const finalSegment = extractNewAudioSegment(
					sessionAudio,
					session.transcribedSamples,
					MAX_SAMPLES,
					MIN_FLUSH_AUDIO_SAMPLES,
				);
				if (finalSegment) {
					await enqueueAnalysis(() =>
						processAudioForTranscript(finalSegment.newAudio, session.settings),
					);
					session.transcribedSamples = finalSegment.totalSamples;
				}

				if (!session.settings.speakerDetection) return;
				if (sessionAudio.length < MIN_DIARIZATION_SAMPLES) return;
				if (sessionAudio.length > MAX_DIARIZATION_SAMPLES) {
					sendModelStatus({
						status: "error",
						message:
							"Recording is longer than 10 minutes. Speaker detection was skipped.",
					});
					return;
				}

				await enqueueAnalysis(() =>
					runPostStopDiarization(sessionAudio, session.settings),
				);
			} catch (err) {
				console.error("Finalize recording failed:", err);
				sendModelStatus({
					status: "error",
					message: String((err as Error)?.message ?? err),
				});
			} finally {
				sendModelStatus({ status: "ready" });
				closeAudioContext(session.audioContext);
				session.chunks.length = 0;
				if (activeSessionRef.current === session) {
					activeSessionRef.current = null;
				}
				if (recorderRef.current === session.recorder) {
					recorderRef.current = null;
				}
				emitCaptureLifecycle("finalize-complete", {
					captureId: session.captureId,
					resourceGeneration: session.generation,
				});
			}
		});
	};

	const createSetupAttempt = (
		generation: number,
		captureId: string,
	): SetupAttempt => {
		let resolveCancel = (_reason: string): void => {};
		const cancelPromise = new Promise<string>((resolve) => {
			resolveCancel = resolve;
		});
		const attempt: SetupAttempt = {
			generation,
			captureId,
			cancelled: false,
			cancelReason: null,
			cancelPromise,
			cancel: (reason: string) => {
				if (attempt.cancelled) return;
				attempt.cancelled = true;
				attempt.cancelReason = reason;
				resolveCancel(reason);
			},
		};
		return attempt;
	};

	const requestMediaStream = async (
		constraints: MediaStreamConstraints,
		attempt: SetupAttempt,
		kind: PendingMediaRequest["kind"],
		timeoutMs: number,
	): Promise<MediaStream> => {
		mediaRequestSequenceRef.current += 1;
		const requestId = mediaRequestSequenceRef.current;
		const pendingRequest: PendingMediaRequest = {
			requestId,
			generation: attempt.generation,
			captureId: attempt.captureId,
			kind,
			timedOut: false,
		};
		pendingMediaRequestsRef.current.set(requestId, pendingRequest);
		emitCaptureLifecycle("media-request-start", {
			captureId: attempt.captureId,
			resourceGeneration: attempt.generation,
			requestId,
			kind,
		});

		const rawOutcome = navigator.mediaDevices.getUserMedia(constraints).then(
			(stream) => ({ type: "stream" as const, stream }),
			(error: unknown) => ({ type: "error" as const, error }),
		);
		void rawOutcome.then((outcome) => {
			pendingMediaRequestsRef.current.delete(requestId);
			const stale =
				attempt.cancelled ||
				pendingRequest.timedOut ||
				attempt.generation !== captureGenerationRef.current;
			let stoppedTracks = 0;
			if (outcome.type === "stream" && stale) {
				stoppedTracks = stopStreamTracks(outcome.stream);
			}
			emitCaptureLifecycle("media-request-settled", {
				captureId: attempt.captureId,
				resourceGeneration: attempt.generation,
				requestId,
				kind,
				outcome: outcome.type,
				stale,
				stoppedTracks,
			});
		});

		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		const timeoutOutcome = new Promise<{ type: "timeout" }>((resolve) => {
			timeoutId = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
		});
		const cancelOutcome = attempt.cancelPromise.then((reason) => ({
			type: "cancelled" as const,
			reason,
		}));
		const outcome = await Promise.race([
			rawOutcome,
			timeoutOutcome,
			cancelOutcome,
		]);
		if (timeoutId !== null) clearTimeout(timeoutId);

		if (outcome.type === "timeout") {
			pendingRequest.timedOut = true;
			emitCaptureLifecycle("media-request-timeout", {
				captureId: attempt.captureId,
				resourceGeneration: attempt.generation,
				requestId,
				kind,
				timeoutMs,
			});
			throw new MediaRequestTimeoutError(kind, timeoutMs);
		}
		if (outcome.type === "cancelled") {
			throw new SetupCancelledError(outcome.reason);
		}
		if (outcome.type === "error") {
			throw outcome.error;
		}
		if (
			attempt.cancelled ||
			attempt.generation !== captureGenerationRef.current
		) {
			stopStreamTracks(outcome.stream);
			throw new SetupCancelledError(
				attempt.cancelReason ?? "capture setup superseded",
			);
		}
		return outcome.stream;
	};

	const setupMediaRecorder = async (
		streamId: string,
		captureId: string,
	): Promise<void> => {
		requestStopRecording("superseded-by-new-start", false);
		const generation = captureGenerationRef.current + 1;
		captureGenerationRef.current = generation;
		const attempt = createSetupAttempt(generation, captureId);
		pendingSetupsRef.current.set(generation, attempt);

		const resources: LiveCaptureResources = {
			generation,
			captureId,
			recorder: null,
			tabStream: null,
			micStream: null,
			mixContext: null,
			monitorContext: null,
		};
		liveCaptureResourcesRef.current = resources;
		setChunks([]);
		const includeMicrophone = settingsRef.current.includeMicrophone ?? false;
		emitCaptureLifecycle("setup-start", {
			captureId,
			resourceGeneration: generation,
		});

		let session: CaptureSession | null = null;
		try {
			const tabStream = await requestMediaStream(
				{
					audio: {
						// @ts-expect-error - Chrome-specific tab capture properties
						mandatory: {
							chromeMediaSource: "tab",
							chromeMediaSourceId: streamId,
						},
					},
				},
				attempt,
				"tab",
				TAB_MEDIA_REQUEST_TIMEOUT_MS,
			);
			resources.tabStream = tabStream;
			if (generation !== captureGenerationRef.current) {
				emitCaptureLifecycle("setup-aborted-after-tab-stream", {
					captureId,
					resourceGeneration: generation,
				});
				releaseOwnedCaptureResources(resources, "stale-tab-stream", false);
				return;
			}
			emitCaptureLifecycle("tab-stream-acquired", {
				captureId,
				resourceGeneration: generation,
				tracks: tabStream.getTracks().length,
			});

			let streamToRecord = tabStream;
			if (includeMicrophone) {
				try {
					const micStream = await requestMediaStream(
						{ audio: true },
						attempt,
						"microphone",
						MICROPHONE_MEDIA_REQUEST_TIMEOUT_MS,
					);
					resources.micStream = micStream;
					if (generation !== captureGenerationRef.current) {
						emitCaptureLifecycle("setup-aborted-after-mic-stream", {
							captureId,
							resourceGeneration: generation,
						});
						releaseOwnedCaptureResources(resources, "stale-mic-stream", false);
						return;
					}

					const mixContext = new AudioContext({
						sampleRate: WHISPER_SAMPLING_RATE,
					});
					resources.mixContext = mixContext;
					const destination = mixContext.createMediaStreamDestination();
					mixContext.createMediaStreamSource(tabStream).connect(destination);
					mixContext.createMediaStreamSource(micStream).connect(destination);
					streamToRecord = destination.stream;
				} catch (micErr) {
					if (generation !== captureGenerationRef.current) {
						releaseOwnedCaptureResources(resources, "stale-mic-request", false);
						return;
					}
					stopStreamTracks(resources.micStream);
					resources.micStream = null;
					closeAudioContext(resources.mixContext);
					resources.mixContext = null;
					console.warn(
						"Microphone access denied, using tab audio only:",
						micErr,
					);
				}
			}

			if (generation !== captureGenerationRef.current) {
				releaseOwnedCaptureResources(resources, "stale-before-recorder", false);
				return;
			}

			const recorder = new MediaRecorder(streamToRecord);
			resources.recorder = recorder;
			recorderRef.current = recorder;
			const audioContext = new AudioContext({
				sampleRate: WHISPER_SAMPLING_RATE,
			});
			const captureSession: CaptureSession = {
				generation,
				captureId,
				recorder,
				chunks: [],
				mimeType: recorder.mimeType,
				audioContext,
				transcribedSamples: 0,
				settings: { ...settingsRef.current },
				processingTail: Promise.resolve(),
				stopping: false,
				finalizeQueued: false,
			};
			session = captureSession;
			activeSessionRef.current = captureSession;

			try {
				const monitorContext = new AudioContext();
				resources.monitorContext = monitorContext;
				monitorContext
					.createMediaStreamSource(tabStream)
					.connect(monitorContext.destination);
			} catch (monitorErr) {
				console.warn("Tab audio monitor could not be started:", monitorErr);
			}

			recorder.onstart = () => {
				if (generation !== captureGenerationRef.current) {
					captureSession.stopping = true;
					captureSession.finalizeQueued = true;
					try {
						recorder.stop();
					} catch {
						// Recorder may already be inactive.
					}
					closeAudioContext(audioContext);
					captureSession.chunks.length = 0;
					releaseOwnedCaptureResources(
						resources,
						"stale-recorder-start",
						false,
					);
					return;
				}

				recordingRef.current = true;
				setRecording(true);
				setChunks([]);
				safeRuntimeSendMessage({
					type: "recording-state",
					data: { recording: true, captureId },
				});
				emitCaptureLifecycle("capture-started", {
					captureId,
					resourceGeneration: generation,
				});
			};

			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) {
					captureSession.chunks.push(event.data);
					if (
						activeSessionRef.current === captureSession &&
						!captureSession.stopping
					) {
						setChunks([...captureSession.chunks]);
					}
					setTimeout(() => {
						if (recorder.state === "recording") recorder.requestData();
					}, 10_000);
				} else {
					setTimeout(() => {
						if (recorder.state === "recording") recorder.requestData();
					}, 25);
				}
			};

			recorder.onstop = () => {
				captureSession.stopping = true;
				if (activeSessionRef.current === captureSession) {
					activeSessionRef.current = null;
				}
				if (recorderRef.current === recorder) {
					recorderRef.current = null;
				}
				void finalizeRecordingSessionRef.current(captureSession);
			};

			recorder.start();
		} catch (err) {
			const stale =
				generation !== captureGenerationRef.current ||
				err instanceof SetupCancelledError;
			if (session) {
				session.stopping = true;
				session.finalizeQueued = true;
				closeAudioContext(session.audioContext);
				session.chunks.length = 0;
				if (activeSessionRef.current === session)
					activeSessionRef.current = null;
			}
			releaseOwnedCaptureResources(resources, "setup-error", false);
			if (stale) {
				emitCaptureLifecycle("setup-error-after-cancel", {
					captureId,
					resourceGeneration: generation,
				});
				return;
			}

			console.error("Setup error:", err);
			const message = err instanceof Error ? err.message : String(err);
			safeRuntimeSendMessage({
				type: "capture-error",
				data: {
					captureId,
					error: ["Failed to start tab audio capture: ", message].join(""),
					errorCode:
						err instanceof MediaRequestTimeoutError
							? "media-request-timeout"
							: "capture-setup-failed",
					requiresRecovery: err instanceof MediaRequestTimeoutError,
				},
			});
		} finally {
			pendingSetupsRef.current.delete(generation);
			emitCaptureLifecycle("setup-settled", {
				captureId,
				resourceGeneration: generation,
			});
		}
	};

	transcribeLatestAudioRef.current = transcribeLatestAudio;
	finalizeRecordingSessionRef.current = finalizeRecordingSession;
	requestStopRecordingRef.current = requestStopRecording;
	setupMediaRecorderRef.current = setupMediaRecorder;

	useEffect(() => {
		if (!recorderRef.current || !recording) return;
		if (chunks.length > 0) {
			void transcribeLatestAudioRef.current();
		} else {
			recorderRef.current.requestData();
		}
	}, [recording, chunks]);

	useEffect(() => {
		const onMessage = (
			message: {
				target?: string;
				type?: string;
				streamId?: string;
				captureId?: string;
				settings?: TranscriptionSettings;
			},
			_sender: chrome.runtime.MessageSender,
			sendResponse: (response?: unknown) => void,
		) => {
			if (message.target !== "offscreen") return;

			if (message.type === "ping-offscreen") {
				safeRuntimeSendMessage({ type: "offscreen-ready" });
				return false;
			}

			if (message.type === "get-offscreen-state") {
				const resources = liveCaptureResourcesRef.current;
				const session = activeSessionRef.current;
				const active =
					pendingSetupsRef.current.size > 0 ||
					countPendingTabMediaRequests(
						pendingMediaRequestsRef.current.values(),
					) > 0 ||
					resources?.recorder?.state === "recording" ||
					recordingRef.current;
				sendResponse({
					recording: active,
					captureId:
						resources?.captureId ??
						session?.captureId ??
						pendingSetupsRef.current.values().next().value?.captureId ??
						pendingMediaRequestsRef.current.values().next().value?.captureId ??
						null,
					pendingSetupCount: pendingSetupsRef.current.size,
					pendingMediaRequestCount: pendingMediaRequestsRef.current.size,
					pendingTabMediaRequestCount: countPendingTabMediaRequests(
						pendingMediaRequestsRef.current.values(),
					),
				});
				return false;
			}

			if (
				message.type === "prepare-capture" ||
				message.type === "stop-recording"
			) {
				const currentCaptureId =
					liveCaptureResourcesRef.current?.captureId ??
					activeSessionRef.current?.captureId ??
					pendingSetupsRef.current.values().next().value?.captureId ??
					pendingMediaRequestsRef.current.values().next().value?.captureId ??
					null;
				if (
					message.captureId &&
					currentCaptureId &&
					message.captureId !== currentCaptureId
				) {
					sendResponse({
						ok: true,
						captureId: currentCaptureId,
						generation: captureGenerationRef.current,
						pendingSetupCount: pendingSetupsRef.current.size,
						pendingMediaRequestCount: pendingMediaRequestsRef.current.size,
						pendingTabMediaRequestCount: countPendingTabMediaRequests(
							pendingMediaRequestsRef.current.values(),
						),
						liveTracksEnded: false,
						wasRecording: recordingRef.current,
						ignoredStaleRequest: true,
					});
					return false;
				}

				const result = requestStopRecordingRef.current(message.type, true);
				sendResponse(result);
				return false;
			}

			if (message.type === "start-recording" && message.streamId) {
				const pendingTabMediaRequestCount = countPendingTabMediaRequests(
					pendingMediaRequestsRef.current.values(),
				);
				if (pendingTabMediaRequestCount > 0) {
					sendResponse({
						accepted: false,
						reason: "media-request-pending",
						pendingMediaRequestCount: pendingMediaRequestsRef.current.size,
						pendingTabMediaRequestCount,
					});
					return false;
				}
				const captureId =
					message.captureId ??
					[
						"legacy",
						Date.now().toString(36),
						captureGenerationRef.current + 1,
					].join("-");
				if (message.settings) {
					settingsRef.current = message.settings;
				}
				sendResponse({ accepted: true, captureId });
				void setupMediaRecorderRef.current(message.streamId, captureId);
				return false;
			}

			return false;
		};

		chrome.runtime.onMessage.addListener(onMessage);
		// Tell the service worker the listener is attached before any start-recording.
		safeRuntimeSendMessage({ type: "offscreen-ready" });

		return () => {
			chrome.runtime.onMessage.removeListener(onMessage);
			requestStopRecordingRef.current("offscreen-unmount", false);
		};
	}, []);

	return (
		<div>
			<h1>Offscreen Document</h1>
		</div>
	);
};

// Avoid StrictMode double-mount in the offscreen capture document (can drop the first
// start-recording while the listener is torn down/re-attached during boot).
const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Offscreen root element is missing.");
}
ReactDOM.createRoot(rootElement).render(<Offscreen />);
