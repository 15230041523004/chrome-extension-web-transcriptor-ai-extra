/**
 * Direct regression checks for local generative output validation.
 * Run: node scripts/test-local-model-output.mjs
 */

import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourcePath = new URL("../src/lib/localSummarizer.ts", import.meta.url);
let moduleSource = await readFile(sourcePath, "utf8");
moduleSource = moduleSource.replace(
	/import \{[\s\S]*?\} from "@\/lib\/asrCleaner";\r?\n/u,
	"",
);
const compiled = ts.transpileModule(moduleSource, {
	compilerOptions: {
		target: ts.ScriptTarget.ES2021,
		module: ts.ModuleKind.ESNext,
	},
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { isDegenerateGeneratedText, parseInstructionSummary } = await import(
	moduleUrl
);

function assert(condition, message) {
	if (!condition) {
		console.error("FAIL:", message);
		process.exitCode = 1;
		return;
	}
	console.log("OK:", message);
}

const degenerateSamples = [
	"Вот я и я вот и вот я знаю что именно Православие и Православие не очень распространено в современном мире и именно поэтому я считаю что это очень важно для нас и для того чтобы вести себя правильно и правильно жить и жить в этом мире очень много и.",
	"Вот и я и его апостолы и апостоли и их апостольские апостолские традиции и как они идут в церковь и как это было именно именно в церкви и когда они ничего не дали и они стали только одним из самых лучших и самых мощных.",
	"Когда я почитаю песню Синан Сара и его ученик и кто именно он говорил о молитве и о том что я слышал и слышал он и сказал о том как именно слышал Кришна и Будда и говорил и когда я не слышал этот именно так и не слышил.",
	"Вот и я и ВС и вся церковь и церковь не могут быть истинной любви там где нет смирения и не могут победить самому себе эти страсти Там где нет истинной любвы Это видение своей греховности Это очень важно ведической традиции этого нет Вот я уже давно и очень много правил.",
];

for (const [index, sample] of degenerateSamples.entries()) {
	assert(
		isDegenerateGeneratedText(sample),
		`rejects supplied degenerate RuT5 bullet ${index + 1}`,
	);
}

assert(
	!isDegenerateGeneratedText(
		"Спикер отвечает, что церковные правила складывались постепенно: сначала возникли апостольские традиции, затем соборные постановления и нормы поместных церквей.",
	),
	"keeps a coherent factual bullet",
);

const source = `
Вопрос посвящён сходству ведических норм поведения с христианством и отсутствию подробных бытовых правил в Евангелии.
Спикер отвечает, что церковные традиции складывались постепенно: от апостолов до соборных постановлений и правил поместных церквей.
Он предостерегает от отождествления Кришны, Христа и Будды в учении Рамакришны и Вивекананды.
В завершение спикер утверждает, что христианская любовь связана со смирением и видением собственной греховности.
`;
const modelOutput = `
- Вопрос касается сходства ведических норм поведения с христианством и подробных бытовых правил.
- Церковные традиции, по словам спикера, складывались постепенно — от апостолов до соборных постановлений.
- Спикер предостерегает от отождествления Кришны, Христа и Будды у Рамакришны и Вивекананды.
- Христианская любовь связывается со смирением и видением собственной греховности.
`;
const parsed = parseInstructionSummary(modelOutput, source);
assert(
	parsed.split("\n").filter(Boolean).length === 4,
	"keeps four grounded Qwen bullets",
);
assert(
	!parsed.includes("Вот я и я"),
	"parsed summary contains no degenerate fragment",
);

if (!process.exitCode) console.log("\nAll local model output fixtures passed.");
