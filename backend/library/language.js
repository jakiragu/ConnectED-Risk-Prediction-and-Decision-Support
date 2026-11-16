/**
 * The fixed wording of what ConnectED sends home: report cards and results SMS.
 *
 * Only ConnectED's own words are translated. What the school typed (names,
 * subjects, renamed exams) and grade letters are shown as entered.
 *
 * Which language: the school sets one for report cards and one for SMS
 * (Settings > School). A guardian's own choice, when a later version records
 * one on the student (student.guardian_language), takes precedence; nothing
 * sets it yet.
 */

export const LANGUAGES = ['en', 'sw'];
export const LANGUAGE_NAME = { en: 'English', sw: 'Kiswahili' };
export const DEFAULT_LANGUAGES = { report_card_language: 'en', sms_language: 'en' };

export const isLanguage = (code) => LANGUAGES.includes(code);

/**
 * The language for one piece of communication.
 * @param {object} settings  the school's language settings
 * @param {'report_card'|'sms'} channel
 * @param {object} [student] the student, whose guardian may have their own choice
 */
export function languageFor(settings, channel, student = null) {
  if (isLanguage(student?.guardian_language)) return student.guardian_language;
  const chosen = settings?.[`${channel}_language`];
  return isLanguage(chosen) ? chosen : DEFAULT_LANGUAGES[`${channel}_language`];
}

const WORDS = {
  en: {
    // report card
    'card.final': 'End of term report card',
    'card.provisional': 'Provisional {label} report',
    'card.student': 'Student',
    'card.admission': 'Adm. no',
    'card.class': 'Class',
    'card.term': 'Term',
    'card.published': 'Published {date}',
    'card.ref': 'Result ref. {ref}',
    'card.mean': 'Mean score',
    'card.examMean': '{label} mean',
    'card.overallGrade': 'Overall grade',
    'card.result': 'Result',
    'card.passed': 'Passed',
    'card.below': 'Below pass mark ({mark}%)',
    'card.passMark': 'Pass mark {mark}%',
    'card.provisionalNote': 'Provisional: the results of one exam, not the term result. No grade is awarded.',
    'card.subject': 'Subject',
    'card.termScore': 'Term score',
    'card.grade': 'Grade',
    'card.meanRow': 'Mean',
    'card.weights': 'Term score = {parts}',
    'card.breakdown': 'How each subject was marked',
    'card.breakdownNote': "Each exam is out of 100. A paper's share is how much of that exam it makes up; its points are its score times that share.",
    'card.component': 'Component',
    'card.score': 'Score',
    'card.share': 'Share',
    'card.points': 'Points',
    'card.key': 'ABS = absent (scores 0)    N/A = not assessed (left out)    - = no mark recorded',
    'card.page': 'Page {n} of {of}',
    'card.continued': '{name}, continued',
    'card.watermark': 'PROVISIONAL',
    // the school's exams, when it kept the default names
    'exam.OPENER': 'Opener',
    'exam.MIDTERM': 'Mid-term',
    'exam.ENDTERM': 'End of term',
    'component.PAPER': 'Paper',
    'component.CAT': 'CAT',
    'component.QUIZ': 'Quiz',
    'component.PRACTICAL': 'Practical',
    'component.PROJECT': 'Project',
    // SMS
    'sms.head.final': '{school}: {term} {label} results for {name} ({adm}), {class}.',
    'sms.head.interim': '{school}: {term} {label} exam results for {name} ({adm}), {class}.',
    'sms.mean': 'Mean {value}.',
    'sms.tail': 'Full report card from the school.',
  },
  sw: {
    'card.final': 'Ripoti ya mwisho wa muhula',
    'card.provisional': 'Ripoti ya muda: {label}',
    'card.student': 'Mwanafunzi',
    'card.admission': 'Nambari ya usajili',
    'card.class': 'Darasa',
    'card.term': 'Muhula',
    'card.published': 'Imechapishwa {date}',
    'card.ref': 'Kumbukumbu {ref}',
    'card.mean': 'Wastani',
    'card.examMean': 'Wastani wa {label}',
    'card.overallGrade': 'Gredi ya jumla',
    'card.result': 'Matokeo',
    'card.passed': 'Amefaulu',
    'card.below': 'Chini ya alama ya kufaulu ({mark}%)',
    'card.passMark': 'Alama ya kufaulu {mark}%',
    'card.provisionalNote': 'Matokeo ya muda: haya ni matokeo ya mtihani mmoja, si matokeo ya muhula. Hakuna gredi inayotolewa.',
    'card.subject': 'Somo',
    'card.termScore': 'Alama ya muhula',
    'card.grade': 'Gredi',
    'card.meanRow': 'Wastani',
    'card.weights': 'Alama ya muhula = {parts}',
    'card.breakdown': 'Jinsi kila somo lilivyosahihishwa',
    'card.breakdownNote': 'Kila mtihani ni kati ya 100. Sehemu ya karatasi ni kiasi inachochangia mtihani huo; pointi zake ni alama zake mara sehemu hiyo.',
    'card.component': 'Kipengele',
    'card.score': 'Alama',
    'card.share': 'Sehemu',
    'card.points': 'Pointi',
    'card.key': 'ABS = hakuwepo (alama 0)    N/A = hakutahiniwa (haihesabiwi)    - = hakuna alama iliyorekodiwa',
    'card.page': 'Ukurasa {n} kati ya {of}',
    'card.continued': '{name}, inaendelea',
    'card.watermark': 'YA MUDA',
    'exam.OPENER': 'Ufunguzi',
    'exam.MIDTERM': 'Katikati ya muhula',
    'exam.ENDTERM': 'Mwisho wa muhula',
    'component.PAPER': 'Karatasi',
    'component.CAT': 'CAT',
    'component.QUIZ': 'Jaribio',
    'component.PRACTICAL': 'Vitendo',
    'component.PROJECT': 'Mradi',
    'sms.head.final': '{school}: Matokeo ya {label}, {term}, ya {name} ({adm}), {class}.',
    'sms.head.interim': '{school}: Matokeo ya mtihani wa {label}, {term}, ya {name} ({adm}), {class}.',
    'sms.mean': 'Wastani {value}.',
    'sms.tail': 'Ripoti kamili inapatikana shuleni.',
  },
};

/** ConnectED's wording for `key` in `language`, with {placeholders} filled in. Falls back to English. */
export function t(language, key, vars = {}) {
  const text = WORDS[language]?.[key] ?? WORDS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined || vars[name] === null ? '' : String(vars[name])));
}

/**
 * An exam's name: the school's own name when it renamed the exam, otherwise
 * ConnectED's name for it in this language.
 */
export function examName(language, checkpoint, labels = null) {
  const own = labels?.[checkpoint];
  if (own && own !== WORDS.en[`exam.${checkpoint}`]) return own;
  return t(language, `exam.${checkpoint}`);
}

/** Every key exists in every language: checked by the tests. */
export const wordKeys = (language) => Object.keys(WORDS[language] || {});
