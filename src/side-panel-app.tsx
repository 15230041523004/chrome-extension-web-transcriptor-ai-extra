import type React from "react";
import { useEffect, useState } from "react";
import { AiSummarizer } from "./components/ai-summarizer";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { useToast } from "./components/ui/use-toast";
import { summarizeWebPage } from "./summarizer";
import { LanguageSelector } from "./components/LanguageSelector";
import {
	type TranscriptionLanguage,
	transcriptionSettingsAtom,
	_TRANLATE_TARGET_LANGUAGES as TRANSLATE_TARGET_LANGUAGES,
	WHISPER_MODELS,
	type WhisperModel,
} from "./jotai/settingAtom";
import { useAtom } from "jotai";
import {
	modelLoadingProgressAtom,
	modelStatusAtom,
} from "./jotai/modelStatusAtom";

// ... rest of the file unchanged ...
