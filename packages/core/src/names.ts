/**
 * Russian names in the cases the interface needs: «Вместо Анны» (genitive),
 * «Упомянуть Марину» (accusative), «к Марине Соколовой» (dative). The
 * server does not know a person's gender, so it is guessed from the first
 * name and the surname's ending; a word whose form is not certain stays as
 * written. Callers that cannot afford a wrong form check
 * `declineRuName(...) !== null` and say the phrase another way.
 */

export type NameCase = "genitive" | "accusative" | "dative";

type Gender = "female" | "male" | "unknown";

const cyrillic = /^[А-ЯЁа-яё-]+$/;

// First names ending in -а/-я that belong to men.
const maleOnA = new Set([
  "никита",
  "илья",
  "кузьма",
  "фома",
  "лука",
  "савва",
  "данила",
  "гаврила",
  "фока",
  "добрыня",
]);
// Men's first names ending in -ь (most such names are women's: Любовь).
const maleSoft = new Set(["игорь", "лазарь", "василь", "гордей"]);
// Stems with a fleeting vowel: Пётр → Петра, Павел → Павла, Лев → Льва.
const fleeting: Record<string, string> = {
  пётр: "Петр",
  петр: "Петр",
  павел: "Павл",
  лев: "Льв",
};
// Short forms used by both: the surname decides.
const either = new Set(["саша", "женя", "валя", "шура", "слава", "паша"]);

const velarOrSibilant = /[гкхжшчщ]$/;

function lower(word: string): string {
  return word.toLocaleLowerCase("ru");
}

/** Keeps the case of the written word: «АННА» stays upper case. */
function withEnding(word: string, cut: number, ending: string): string {
  const stem = word.slice(0, word.length - cut);
  const upper = word === word.toLocaleUpperCase("ru") && word.length > 1;
  return stem + (upper ? ending.toLocaleUpperCase("ru") : ending);
}

function surnameGender(word: string): Gender {
  const w = lower(word);
  if (/(ова|ева|ёва|ина|ына|ская|цкая|ая)$/.test(w)) return "female";
  if (/(ов|ев|ёв|ин|ын|ский|цкий|ой|ый|ий)$/.test(w)) return "male";
  return "unknown";
}

function firstNameGender(word: string): Gender {
  const w = lower(word);
  if (either.has(w) || maleOnA.has(w))
    return either.has(w) ? "unknown" : "male";
  if (maleSoft.has(w) || w in fleeting) return "male";
  if (/[ая]$/.test(w)) return "female";
  if (/[бвгджзйклмнпрстфхцчшщ]$/.test(w)) return "male";
  return "unknown";
}

/** -а/-я nouns (Анна, Мария, Илья, Никита), the same for both genders. */
function declineA(word: string, form: NameCase): string | null {
  const w = lower(word);
  if (w.endsWith("ия")) {
    // Мария → Марии, Марию, Марии.
    return withEnding(word, 1, form === "accusative" ? "ю" : "и");
  }
  if (w.endsWith("ья")) {
    // Илья → Ильи, Илью, Илье.
    return withEnding(
      word,
      1,
      form === "genitive" ? "и" : form === "accusative" ? "ю" : "е",
    );
  }
  if (w.endsWith("я"))
    return withEnding(
      word,
      1,
      form === "genitive" ? "и" : form === "accusative" ? "ю" : "е",
    );
  if (w.endsWith("а")) {
    const stem = w.slice(0, -1);
    const genitive = velarOrSibilant.test(stem) ? "и" : "ы";
    return withEnding(
      word,
      1,
      form === "genitive" ? genitive : form === "accusative" ? "у" : "е",
    );
  }
  return null;
}

/** A man's first name or surname ending in a consonant, -й or -ь. */
function declineMaleConsonant(word: string, form: NameCase): string | null {
  const w = lower(word);
  if (w.endsWith("ь") || w.endsWith("й"))
    return withEnding(word, 1, form === "dative" ? "ю" : "я");
  if (/[бвгджзклмнпрстфхцчшщ]$/.test(w)) {
    // Павел → Павла, Лев → Льва: fleeting vowels are not guessed.
    if (/(ел|ев)$/.test(w) && w.length <= 5) return null;
    return word + (form === "dative" ? "у" : "а");
  }
  return null;
}

function declineFirstName(
  word: string,
  form: NameCase,
  gender: Gender,
): string | null {
  const w = lower(word);
  if (!cyrillic.test(word)) return null;
  if (/[ая]$/.test(w)) return declineA(word, form);
  const stem = fleeting[w];
  if (stem) return stem + (form === "dative" ? "у" : "а");
  if (gender === "male") return declineMaleConsonant(word, form);
  // A woman's name ending in a consonant (Любовь, Ирэн) or a vowel other
  // than -а/-я (Мари, Нелли) does not decline in the forms needed here.
  if (gender === "female" && !/[ая]$/.test(w)) {
    if (w.endsWith("ь")) return null;
    return word;
  }
  return null;
}

function declineSurname(
  word: string,
  form: NameCase,
  gender: Gender,
): string | null {
  const w = lower(word);
  if (!cyrillic.test(word)) return null;
  if (/(ова|ева|ёва|ина|ына)$/.test(w))
    return withEnding(word, 1, form === "accusative" ? "у" : "ой");
  if (/(ская|цкая)$/.test(w))
    return withEnding(word, 2, form === "accusative" ? "ую" : "ой");
  if (/ая$/.test(w))
    return withEnding(word, 2, form === "accusative" ? "ую" : "ой");
  if (/(ов|ев|ёв|ин|ын)$/.test(w))
    // Лев, Шин: too short to tell a suffix from a root.
    return w.length <= 3 ? null : word + (form === "dative" ? "у" : "а");
  if (/(ой|ый|ий)$/.test(w))
    return withEnding(word, 2, form === "dative" ? "ому" : "ого");
  // Indeclinable endings: Шевченко, Дурново, Живаго, Черных, Седых.
  if (/(о|е|и|у|ю|ых|их)$/.test(w)) return word;
  if (/[ая]$/.test(w)) return declineA(word, form);
  // A consonant: a man's surname declines (Шевчук → Шевчука), a woman's does not.
  if (gender === "female") return word;
  if (gender === "male") return declineMaleConsonant(word, form);
  return null;
}

/**
 * A display name «Имя» or «Имя Фамилия» (more words — the rest stay as
 * written) in the case asked; null when a word's form is not certain
 * (a Latin name, an unknown gender, a fleeting vowel).
 */
export function declineRuName(name: string, form: NameCase): string | null {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const [first, second] = words;
  let gender = firstNameGender(first!);
  if (gender === "unknown" && second) gender = surnameGender(second);
  if (gender === "unknown" && !second && /[ая]$/.test(lower(first!)))
    gender = "female";
  const firstForm = declineFirstName(first!, form, gender);
  if (firstForm === null) return null;
  if (!second) return firstForm;
  const secondForm = declineSurname(second, form, gender);
  if (secondForm === null) return null;
  return [firstForm, secondForm, ...words.slice(2)].join(" ");
}

/** The first word of a display name: «Анна» of «Анна Иванова». */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * The first name in the case asked, or as written when its form is not
 * certain — for short lines where a nominative still reads: «Упомянуть
 * Марину» / «Упомянуть Ирэн».
 */
export function firstNameIn(name: string, form: NameCase): string {
  const first = firstName(name);
  return declineRuName(first, form) ?? first;
}
