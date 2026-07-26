/**
 * Structural quality fixture for summary emit gates (mirrors asrCleaner rules).
 * Fails on mid-phrase dump openers from unpunctuated YouTube captions.
 *
 * Run: node scripts/test-summary-quality-fixture.mjs
 */

const FILLER_SINGLE = new Set([
	"ну",
	"вот",
	"типа",
	"типо",
	"короче",
	"короч",
	"значит",
	"блин",
	"вообще",
	"просто",
	"ладно",
	"давайте",
	"погнали",
	"слушай",
	"собственно",
	"да",
	"нет",
	"а",
	"и",
	"э",
	"ээ",
	"эээ",
	"эм",
	"эмм",
	"мм",
	"ммм",
	"хм",
	"хмм",
	"угу",
	"ага",
	"ок",
	"окей",
]);

const MID_PHRASE_OPENERS =
	/^(и|а|но|эти|потом|вести|то|ну|же|дело|говорил|говорили|сказал|сказали|складываются|истоки|бы|ли|да|в|за|с|из|у|о|к|от|по|для|при|под|над|на|со|об|про|без|до|после|через|между|среди|слышите)$/u;

const SOFT_OPENERS =
	/^(как|если|это|вот|буквально|распространено|далее|также|кроме|причём|причем)$/u;

const THESIS_GLUE_RE =
	/то\s+есть|потому\s+что|потому|получается\s+что|получается|в\s+отличие/iu;

const VERBISH_OPENER_RE =
	/^(?:[\p{L}]{4,}(?:ал|ил|ел|ыл|ала|ила|ела|ыла|али|или|ели|ыли|ют|ат|ят|ает|яет|ует|иет|ит|ет|ут|ют))$/u;

function tokenizeWords(text) {
	return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
}

function startsNounPhraseTail(text) {
	const words = tokenizeWords(text);
	if (words.length < 2) return false;
	const first = words[0] ?? "";
	const second = words[1] ?? "";
	if (
		/^[\p{L}]{5,}(?:ии|ий|ей|ям|ях|ами|ями|ого|ему|ому|ой|ых|их|ью|ом|ем)$/u.test(
			first,
		) &&
		/^(и|а|но|что|как|там|где|это|он|она|они|с|на|в)$/u.test(second)
	) {
		return true;
	}
	if (
		/^[\p{L}]{4,}и$/u.test(first) &&
		/^(там|где|нет|это)$/u.test(second) &&
		!SOFT_OPENERS.test(first)
	) {
		return true;
	}
	return false;
}

function isStructuralMidOpener(text) {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return true;
	if (/^то\s+есть(?:\s|$)/iu.test(s)) return false;
	if (/^потому\s+что(?:\s|$)/iu.test(s)) return false;
	if (/^в\s+отличие(?:\s|$)/iu.test(s)) return false;
	if (/^что\s+вы(?:\s|$)/iu.test(s)) return true;
	if (/^слышите(?:\s|$)/iu.test(s)) return true;
	const first = tokenizeWords(s)[0] ?? "";
	if (MID_PHRASE_OPENERS.test(first)) return true;
	if (startsNounPhraseTail(s)) return true;
	return false;
}

function hasThesisGlue(text) {
	return THESIS_GLUE_RE.test(text);
}

const CLOSED_CLASS_LAST_RE =
	/^(и|а|но|что|как|это|ваш[аеиух]*|наш[аеиух]*|то|ну|вот|же|бы|ли|да|в|на|о|к|с|из|у|не|для|при|под|над|от|по|со|об|про|без|до|после|через|очень|сильно|именно|совсем|ещё|еще|более|менее|хотя|данный|дан|дал|дали)$/u;
const FINITE_VERB_LAST_RE =
	/^[\p{L}]{4,}(?:ает|яет|ует|иет|ают|яют|уют|ит|ет|ут|ют|ал|ил|ел|ыл|ала|ила|ела|ыла|али|или|ели|ыли|лся|лась|лось|лись|ёт|ешь|ете|ем)$/u;
const ADJECTIVE_LIKE_LAST_RE =
	/^[\p{L}]{5,}(?:ский|ской|цкий|цкой|ный|ной|ний|овый|евый|ический|еский|ая|ое|ые|ый|ий|ых|их|кий|тый|мый|тельной|тельная|тельное)$/u;

function endsIncomplete(text) {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return true;
	if (/[.!?…]$/u.test(s)) return false;
	const words = tokenizeWords(s);
	if (words.length === 0) return true;
	const last = words[words.length - 1] ?? "";
	const penult = words.length >= 2 ? words[words.length - 2] : "";
	if (last.length <= 3) return true;
	if (CLOSED_CLASS_LAST_RE.test(last)) return true;
	if (FINITE_VERB_LAST_RE.test(last)) return true;
	if (words.length >= 4 && ADJECTIVE_LIKE_LAST_RE.test(last)) return true;
	if (
		words.length >= 4 &&
		ADJECTIVE_LIKE_LAST_RE.test(penult) &&
		last.length <= 10 &&
		!CLOSED_CLASS_LAST_RE.test(last)
	) {
		return true;
	}
	return false;
}

function isIncompleteThought(text) {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return true;
	if (isStructuralMidOpener(s)) return true;
	if (endsIncomplete(s)) return true;
	if (/[.!?…]$/u.test(s)) return false;
	const words = tokenizeWords(s);
	if (words.length < 8) return true;
	const first = words[0] ?? "";
	if (VERBISH_OPENER_RE.test(first) && !hasThesisGlue(s)) return true;
	return false;
}

function unitSoftPenalty(text) {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return 1;
	const words = tokenizeWords(s);
	let p = 0;
	const first = words[0] ?? "";
	if (MID_PHRASE_OPENERS.test(first)) p += 0.55;
	return Math.min(1, p);
}

function unitInfoScore(text) {
	const words = tokenizeWords(text);
	if (words.length === 0) return 0;
	const medium = words.filter((w) => w.length >= 4).length;
	const content = words.filter((w) => w.length >= 5 && !FILLER_SINGLE.has(w)).length;
	const mediumRatio = medium / words.length;
	const contentNorm = Math.min(1, content / 15);
	const base = mediumRatio * 0.5 + contentNorm * 0.5;
	return Math.max(0, base * (1 - unitSoftPenalty(text)));
}

function isBulletEligible(text) {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return false;
	const lower = s.toLocaleLowerCase();
	if (/вы\s+слышите/iu.test(lower)) return false;
	if (isStructuralMidOpener(s)) return false;
	const words = tokenizeWords(s);
	if (words.length < 10) return false;
	const first = words[0] ?? "";
	const glue = hasThesisGlue(s);
	const content = words.filter((w) => w.length >= 5 && !FILLER_SINGLE.has(w)).length;
	if (content < 5) return false;
	if (VERBISH_OPENER_RE.test(first) && !glue) return false;
	const info = unitInfoScore(s);
	if (glue && info >= 0.22) return true;
	if (info >= 0.32) return true;
	if (content >= 8 && info >= 0.25) return true;
	return false;
}

function validateSummaryBullet(text) {
	const s = text.replace(/\s+/g, " ").trim().replace(/^[-*•]\s+/, "");
	if (s.length < 28) return false;
	if ((s.match(/[\p{L}]/gu) ?? []).length < 18) return false;
	if (!isBulletEligible(s)) return false;
	if (isIncompleteThought(s)) return false;
	return true;
}

/** Bad bullets from the ck5RLZ1hajM extractive dump — must all be rejected. */
const DUMP_BAD_BULLETS = [
	"Объясняют В общем некие законы поведения именно чистой жизни которые очень похожи на то что проповедовал нам Христос Мне кажется что вот одна из причин что в современном мире Православия не очень сильно распространено то что там ну как бы не Дан чёткий свод законов как себя вести как допустим есть у иудеев есть веи",
	"Бы книгу правил только сколько там постановлений соборных и вселенских поместных соборах некоторых святых отцов потом в каждой даже поместной церкви в частности в русской церкви сколько Опять тоже самое Возьмите до чего была замечательна у нас",
	"Начинает создаваться церковь организовываться как вот знаете из семени постепенно начинает вырастать древо и мы видим что в церкви как же очень много регламентации Возьмите хотя",
	"В этих внешних формах но в отношени Вет Будьте осторожны один из самых таких Ну я бы сказал ну влиятельных вторитетных таких представителей индуизма рамакришна Возьмите Да который говорил Неважно кто он один это и Кришна и Христос и Будда слышите",
	"За столом с обедом молчанием с благоговением все вкушаю пищу слышите Если кто-то засмеётся лучше ложкой в лоб ребёнка происходило великое дело питание что вы какая была Великолепная традиция что сделали с ней что сделали с ней а в монастырях Ну как же за обедом за трапезой читаются читает Житие святых или чьи-то",
	"Психологии и происходит просто буквально Ну изменение на ходу Что называется не удивляйтесь этому нисколько Было бы очень приятно если они настолько изменили что и Христа признали только тогда Приветствую но корни и истоки Ну что вы буды например знаете что говорил я сам всего достиг я сам всё получил Да я сам достиг",
];

/** Structural mid-openers that must never pass as bullets. */
const STRUCTURAL_OPENER_SAMPLES = [
	"Бы книгу правил только сколько там постановлений соборных",
	"В этих внешних формах но в отношении будьте осторожны один из самых",
	"За столом с обедом молчанием с благоговением все вкушают пищу",
	"Психологии и происходит просто буквально ну изменение на ходу",
	"любви там где нет смирения а смирение это что такое",
	"слышите нанда его знаменитый ученик ездил по всему миру",
];

/** Acceptable complete-ish extractive clauses (should pass). */
const GOOD_SAMPLES = [
	"То есть получается что есть очень много про духовную сферу и это приводит нас к жизни вечной.",
	"Христианство призывает человека к богоподобию, и там где нет смирения не может быть истинной любви.",
	"Обычаи и традиции складываются постепенно, и апостолы начинают создавать эти традиции.",
];

let failed = 0;

function assert(cond, msg) {
	if (!cond) {
		console.error("FAIL:", msg);
		failed += 1;
	} else {
		console.log("ok:", msg);
	}
}

for (const b of DUMP_BAD_BULLETS) {
	assert(
		!validateSummaryBullet(b),
		`reject dump bullet starting «${b.slice(0, 28)}…»`,
	);
}

for (const b of STRUCTURAL_OPENER_SAMPLES) {
	assert(isStructuralMidOpener(b) || isIncompleteThought(b), `mid-opener: ${b.slice(0, 40)}`);
	assert(!validateSummaryBullet(b), `reject structural: ${b.slice(0, 40)}`);
}

// Glue loophole: bare «причин» must not unblock verb openers.
const verbWithPrichin =
	"Объясняют в общем некие законы поведения именно чистой жизни которые очень похожи на то что проповедовал нам Христос мне кажется что вот одна из причин что в современном мире";
assert(!hasThesisGlue(verbWithPrichin) || isIncompleteThought(verbWithPrichin), "причин alone is not enough");
assert(!validateSummaryBullet(verbWithPrichin), "verb+причин mid-slice rejected");

for (const b of GOOD_SAMPLES) {
	assert(validateSummaryBullet(b), `accept good: ${b.slice(0, 48)}…`);
}

// endsIncomplete should force merge on adjective mid-NP cuts.
assert(
	endsIncomplete(
		"модификации которые здесь существуют приспособительной христианской",
	),
	"ends incomplete on adjective cut",
);

// --- ~10% char budget helpers (mirrors localSummarizer) ---
const SUMMARY_RATIO_TARGET = 0.1;
const SUMMARY_RATIO_MIN = 0.06;
const SUMMARY_RATIO_MAX = 0.15;

function summaryCharBudget(sourceChars) {
	const n = Math.max(0, Math.floor(sourceChars));
	if (n < 200) {
		return { min: 40, target: Math.max(80, Math.round(n * 0.2)), max: Math.max(120, n) };
	}
	return {
		min: Math.round(n * SUMMARY_RATIO_MIN),
		target: Math.round(n * SUMMARY_RATIO_TARGET),
		max: Math.round(n * SUMMARY_RATIO_MAX),
	};
}

function summaryBodyChars(markdown) {
	const lines = markdown.split(/\n+/).map((l) => l.trim()).filter(Boolean);
	let total = 0;
	for (const line of lines) {
		if (line.startsWith("#")) continue;
		const body = line.replace(/^[-*•]\s+/, "").trim();
		if (body) total += body.length;
	}
	return total;
}

const budget5k = summaryCharBudget(5000);
assert(budget5k.target === 500, `budget target 500 for 5k, got ${budget5k.target}`);
assert(budget5k.min === 300, `budget min 300 for 5k, got ${budget5k.min}`);
assert(budget5k.max === 750, `budget max 750 for 5k, got ${budget5k.max}`);

const shortHalluc =
	"- Учитие духовные и мируемые нормы может помочь лучше понять общество.\n" +
	"- Традиционные умы, такие в Евангелии и Японии, дают основу для духовного понима.\n" +
	"- Обед, смирение и питанье в монастыре помогают в духовном осознании.";
const shortBody = summaryBodyChars(shortHalluc);
assert(shortBody < budget5k.min, `short dump body ${shortBody} < min ${budget5k.min}`);

// Synthetic long grounded notes ≈ 10% of a 5000-char source.
const longSource = `${"слово ".repeat(900)}христос церковь смирение любовь правила ведические традиции апостолы `.repeat(2);
const longSourceChars = longSource.replace(/\s+/g, " ").trim().length;
const longBudget = summaryCharBudget(longSourceChars);
const longNotes = [
	"Гость спрашивает, почему у Православия нет такого подробного свода правил поведения, как у иудеев и в ведических описаниях жизни.",
	"Ответ: обычаи и традиции складываются постепенно, апостолы и церковь создают регламентацию, в том числе книгу правил.",
	"Пример живой регламентации — молчание и благоговение за столом, чтение житий в монастырях, и разрушение этих форм изнутри.",
	"Предостережение о модификациях индуизма: отождествление Христа с другими фигурами и отрицание греховности — чуждо сути.",
	"Христианство призывает к богоподобию; истинная любовь невозможна без смирения как видения своей греховности.",
]
	.map((b) => `- ${b}`)
	.join("\n");
const longBody = summaryBodyChars(longNotes);
assert(
	longBody >= longBudget.min * 0.5,
	`long notes have substantial body ${longBody} (source ${longSourceChars})`,
);
assert(longBody > shortBody * 2, "long notes carry more chars than short halluc dump");

// Last-third coverage helper (mirrors fitSummaryToCharBudget band split).
function bodyKey(u) {
	return u.toLocaleLowerCase().replace(/^[-*•]\s+/, "").slice(0, 64);
}
function coversTailBand(lines, eligible) {
	const n = eligible.length;
	if (n < 6) return true;
	const tailStart = Math.min(n - 1, Math.floor((2 * n) / 3));
	const tailBand = eligible.slice(tailStart);
	const tailKeys = new Set(tailBand.map((u) => bodyKey(u)));
	return lines.some((l) => {
		const k = bodyKey(l);
		if (tailKeys.has(k)) return true;
		for (const tk of tailKeys) {
			if (
				k.length > 28 &&
				tk.length > 28 &&
				(k.includes(tk.slice(0, 32)) || tk.includes(k.slice(0, 32)))
			) {
				return true;
			}
		}
		return false;
	});
}

// 9 complete generic units — early fill must not drop distinct late token.
const nineUnits = [
	"В начале лекции ведущий формулирует цель занятия и план на сегодня подробно.",
	"Далее объясняется первая часть материала с примерами из предыдущего урока.",
	"Слушатели задают уточняющий вопрос о границах применимости этого правила.",
	"Ответ строится вокруг постепенного накопления практики и повторения.",
	"В середине приводится сравнение двух подходов без лишних отступлений.",
	"Затем разбирается типичная ошибка и как её избежать на практике.",
	"Ближе к концу звучит предостережение о поверхностных интерпретациях темы.",
	"Заключительный тезис подчёркивает необходимость смирения перед сложностью предмета.",
	"Итог: без опоры на исходные принципы пересказ становится бессвязным набором фраз.",
];
const earlyOnly = nineUnits.slice(0, 4).map((u) => `- ${u}`);
const lateToken = "бессвязным";
assert(
	!coversTailBand(earlyOnly, nineUnits),
	"early-only selection does not cover tail band",
);
const withTail = [...earlyOnly, `- ${nineUnits[8]}`];
assert(coversTailBand(withTail, nineUnits), "adding last unit covers tail band");
assert(
	withTail.some((l) => l.includes(lateToken)),
	"tail bullet retains distinctive late token",
);

// subsample keep-ends: first and last always present
function subsampleUnitsKeepEnds(units, maxUnits) {
	if (units.length <= maxUnits) return units;
	if (maxUnits <= 1) return [units[units.length - 1]];
	if (maxUnits === 2) return [units[0], units[units.length - 1]];
	const indexes = new Set([0, units.length - 1]);
	for (let i = 1; i < maxUnits - 1; i += 1) {
		indexes.add(Math.round((i * (units.length - 1)) / (maxUnits - 1)));
	}
	return [...indexes].sort((a, b) => a - b).map((i) => units[i]);
}
const kept = subsampleUnitsKeepEnds(nineUnits, 4);
assert(kept[0] === nineUnits[0], "keep-ends preserves first");
assert(kept[kept.length - 1] === nineUnits[8], "keep-ends preserves last");

if (failed > 0) {
	console.error(`\n${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("\nAll summary quality fixture checks passed.");
