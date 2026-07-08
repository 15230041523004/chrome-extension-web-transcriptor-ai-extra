import { buildPhraseChunks, classifyInterviewLineSpeaker } from "../src/lib/phraseChunks.ts";
import { mergeDiarizationWithTranscript } from "../src/lib/mergeDiarization.ts";

const sample = [
	{
		text: "Ай, скажи пожалуйста, вот если бы ты оказалась в таком коллективе... Я никогда не буду уважать человека, которого видела пьян.",
		timestamp: [0, 45],
	},
	{ text: "А можно вопрос?", timestamp: [45, 46] },
	{
		text: "- Я не хочу… Ты понимаешь, когда не будь была женщина, которая не была, когда жива в своей жизни, нет, которая, когда ибо своей жизни, не была очень пьяна. Да, я… Вы не были",
		timestamp: [46, 58],
	},
	{
		text: "- Я не была. - Я думал, что ты на вам пьяный. - Наверное, может, ты можешь не верить. - Можешь сказать мне, но я никогда не была пьяна, потому что у меня есть чёткий стоп. - Я понимаю, что ты в жизни не знаешь, что такое. - А что, ты знаешь? - Я не опьянен. - 15 лет, я всегда... - А 15? - А пила? А пила с другом? - А пила с другом? - Ну тоже как-то. Ты меня проси, пожалуйста. Ты меня проссти, пожалуйста. Ну тоже странно.",
		timestamp: [58, 120],
	},
];

const chunks = buildPhraseChunks(sample);
console.log("--- Phrase chunks ---");
for (const chunk of chunks) {
	const who = classifyInterviewLineSpeaker(chunk.text) ?? "?";
	console.log(`[${who}] ${chunk.text.slice(0, 80)}${chunk.text.length > 80 ? "…" : ""}`);
}

const segments = [
	{ id: 0, start: 0, end: 120, confidence: 0.5 },
	{ id: 1, start: 45, end: 50, confidence: 0.5 },
];
const merged = mergeDiarizationWithTranscript(segments, chunks);
console.log("\n--- Merged output ---\n" + merged);