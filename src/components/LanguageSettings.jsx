import { useEffect, useState } from 'react';
import { LANGUAGES, LANGUAGE_NAME, t } from '@gradebook/domain/language';
import { gql } from '../api/graphql.js';
import { GET_LANGUAGE_SETTINGS, SAVE_LANGUAGE_SETTINGS } from '../api/operations.js';
import { Field, Select } from './Field.jsx';
import { Notice } from './ui.jsx';

const OPTIONS = LANGUAGES.map((code) => ({ value: code, label: LANGUAGE_NAME[code] }));

/**
 * The language of what goes to parents: report cards and results SMS, set for the whole school.
 * Only ConnectED's wording changes; names, subjects and grades stay as the school entered them.
 */
export default function LanguageSettings({ schoolId, online = true, onDirtyChange }) {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    gql(GET_LANGUAGE_SETTINGS, { school_id: schoolId })
      .then(({ getLanguageSettings }) => { setSaved(getLanguageSettings); setForm(getLanguageSettings); })
      .catch((e) => setError(e.message));
  }, [schoolId]);

  const dirty = Boolean(form && saved)
    && (form.report_card_language !== saved.report_card_language || form.sms_language !== saved.sms_language);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  async function save() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const { saveLanguageSettings } = await gql(SAVE_LANGUAGE_SETTINGS, {
        input: {
          school_id: schoolId,
          report_card_language: form.report_card_language,
          sms_language: form.sms_language,
          _version: saved._version,
        },
      });
      setSaved(saveLanguageSettings);
      setForm(saveLanguageSettings);
      setNotice('Saved. Report cards made and messages sent from now on use these languages.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !form) return <div className="card settings-card"><h2>Language for parents</h2><Notice tone="error">{error}</Notice></div>;
  if (!form) return <div className="card settings-card"><h2>Language for parents</h2><p className="hint" role="status">Loading…</p></div>;

  const card = form.report_card_language;
  const sms = form.sms_language;
  return (
    <div className="card settings-card stack language-settings">
      <div>
        <h2>Language for parents</h2>
        <p className="hint">
          ConnectED’s own wording is translated. Names, subjects and grades stay exactly as your school entered them.
        </p>
      </div>

      <div className="language-grid">
        <div className="language-choice">
          <Field label="Report cards" htmlFor="report-card-language">
            <Select id="report-card-language" value={card} options={OPTIONS}
              onChange={(v) => { setNotice(null); setForm((f) => ({ ...f, report_card_language: v })); }} />
          </Field>
          <div className="language-sample" aria-label="Example">
            <span className="hint">Example</span>
            <b>{t(card, 'card.final').toUpperCase()}</b>
            <span>{t(card, 'card.mean')} · {t(card, 'card.overallGrade')} · {t(card, 'card.passed')}</span>
          </div>
        </div>

        <div className="language-choice">
          <Field label="Results SMS" htmlFor="sms-language">
            <Select id="sms-language" value={sms} options={OPTIONS}
              onChange={(v) => { setNotice(null); setForm((f) => ({ ...f, sms_language: v })); }} />
          </Field>
          <div className="language-sample" aria-label="Example">
            <span className="hint">Example</span>
            <span>
              {t(sms, 'sms.head.interim', {
                school: 'Your school', term: 'Term 1', label: t(sms, 'exam.MIDTERM'),
                name: 'Amina Achieng', adm: '17073', class: 'Form 2 West',
              })} {t(sms, 'sms.mean', { value: '58.4%' })} {t(sms, 'sms.tail')}
            </span>
          </div>
        </div>
      </div>

      <p className="hint">
        Report cards already made keep the language they were made in. Kiswahili messages can run longer, so a message may cost an extra SMS.
      </p>
      {notice && <Notice>{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="row">
        <button type="button" className="btn primary" disabled={!dirty || busy || !online} onClick={save}>
          {busy ? 'Saving…' : 'Save languages'}
        </button>
        {saved.updated_by_name && (
          <span className="hint">Last changed by {saved.updated_by_name}{saved.updated_at ? ` on ${saved.updated_at.slice(0, 10)}` : ''}</span>
        )}
      </div>
    </div>
  );
}
