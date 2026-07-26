/**
 * Chronological order heuristic + line-based clean smoke tests.
 * Run: node scripts/test-chrono-order.mjs
 * Neutral fixtures only (no video/domain dump phrases).
 */

const TRANSCRIPT_OPENING_RE =
	/(?:^|[\s,.])(?:приветствую|здравствуй(?:те)?|добрый\s+(?:день|вечер)|хочу\s+выразить|хочу\s+вам\s+поклон|поклон(?:юсь|иться)|от\s+имени\s+всех|разрешите\s+начать|начн[её]м\s+с)/iu;

function ensureChronologicalLines(lines) {
	if (lines.length < 6) return lines;
	const n = lines.length;
	const headN = Math.min(10, Math.max(3, Math.floor(n * 0.15)));
	const tailN = headN;
	const head = lines.slice(0, headN).join(" ");
	const tail = lines.slice(n - tailN).join(" ");
	const headOpen = TRANSCRIPT_OPENING_RE.test(head);
	const tailOpen = TRANSCRIPT_OPENING_RE.test(tail);
	if (tailOpen && !headOpen) return [...lines].reverse();
	return lines;
}

function assert(cond, msg) {
	if (!cond) {
		console.error("FAIL:", msg);
		process.exitCode = 1;
		return;
	}
	console.log("OK:", msg);
}

// Opening greeting is at the end → reverse to chrono order
const reversed = [
	"итог лекции и краткий список правил",
	"середина разбора с тремя примерами",
	"дальше идут детали второго раздела",
	"ещё один факт о предмете урока",
	"план темы и цели на сегодня",
	"введение в структуру материала",
	"хочу выразить вам своё великое почтение",
	"здравствуйте и добро пожаловать на урок",
];

const fixed = ensureChronologicalLines(reversed);
assert(
	/почтение|здравствуйте/i.test(fixed[0] + " " + fixed[1]),
	"greeting moves to start after reverse",
);
assert(
	!/почтение/i.test(fixed[fixed.length - 1]),
	"greeting not only at end",
);

const alreadyOk = [
	"хочу выразить вам своё великое почтение",
	"сегодня мы разберём первую тему урока",
	"далее идут три коротких примера",
	"затем правила и исключения",
	"в середине есть важный вывод",
	"в конце краткое повторение",
	"итог и список того что запомнить",
];
const same = ensureChronologicalLines(alreadyOk);
assert(same[0] === alreadyOk[0], "already chrono left unchanged");

if (!process.exitCode) console.log("\nAll chrono-order fixtures passed.");
