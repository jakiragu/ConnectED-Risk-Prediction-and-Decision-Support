import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import {
  LIST_REPORT_CARDS, LIST_RESULT_SETS, PREVIEW_RESULTS_SMS, REQUEST_REPORT_CARD_DOWNLOAD, SEND_RESULTS_SMS,
} from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Offline, ActionIcon, Dialog, Notice } from '../components/ui.jsx';
import { Select } from '../components/Field.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { useTerms } from '../offline/useTerms.js';
import { useCheckpointSetup } from '../offline/useCheckpointSetup.js';
import { byClassOrder, classLabel } from '../classLabels.js';

/** Starts a browser download from a short-lived link; the server sets the file name. */
function save(url, fileName) {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi' }) : '');
/** Can this card's guardian be texted at all (a number, and not opted out)? */
const reachable = (c) => c.has_guardian_phone && c.results_sms;
/** Who "Text parents" would send to: reachable and not already sent this result. */
const toSend = (cards) => cards.filter((c) => reachable(c) && c.sms_status !== 'SENT');

/** One line saying what a send did, from the server's tally. */
function outcomeText(o) {
  const parts = [];
  if (o.sent) parts.push(`Sent to ${plural(o.sent, 'parent')}.`);
  if (o.failed) parts.push(`${plural(o.failed, 'message')} failed; the reason is on each row.`);
  if (o.not_attempted) parts.push(`${plural(o.not_attempted, 'message')} not sent yet.`);
  if (!o.sent && !o.failed && !o.not_attempted) parts.push('Nothing to send: every reachable parent already has this result.');
  if (o.problem) parts.push(o.problem);
  return parts.join(' ');
}

/** The Parent SMS cell: what happened to this result's message, or why there is none. */
function SmsCell({ card, classId }) {
  if (!card.has_guardian_phone) {
    return (
      <span className="hint">
        No number · <Link to={`/classes/${classId}/students?edit=${card.student_id}`}>Add</Link>
      </span>
    );
  }
  if (!card.results_sms) return <span className="hint">Opted out</span>;
  if (card.sms_status === 'SENT') {
    return (
      <span className="pill recorded" title={`Accepted by the SMS provider${card.sms_to_hint ? `, to ${card.sms_to_hint}` : ''}`}>
        <ActionIcon name="check" />Sent {shortDate(card.sms_at)}
      </span>
    );
  }
  if (card.sms_status === 'FAILED') {
    return (
      <div className="sms-failed">
        <span className="pill unrecorded">Failed</span>
        {card.sms_problem && <span className="hint">{card.sms_problem}</span>}
      </div>
    );
  }
  if (card.sms_status === 'SENDING') return <span className="pill recording">Sending</span>;
  return <span className="hint">Not sent</span>;
}

/**
 * Confirms a send before anything goes out: who gets it, who is skipped and
 * why, and the message itself. Every SMS costs credit and cannot be unsent.
 */
function SmsDialog({ ask, cards, scope, onClose, onSent }) {
  const one = ask.card;
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    gql(PREVIEW_RESULTS_SMS, { ...scope, student_id: one?.student_id ?? null })
      .then((d) => { if (live) setPreview(d.previewResultsSms); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [scope, one]);

  const recipients = one ? 1 : toSend(cards).length;
  const noNumber = cards.filter((c) => !c.has_guardian_phone).length;
  const optedOut = cards.filter((c) => c.has_guardian_phone && !c.results_sms).length;
  const already = cards.filter((c) => reachable(c) && c.sms_status === 'SENT').length;
  const skipped = [
    noNumber && `${noNumber} with no number`,
    optedOut && `${optedOut} opted out`,
    already && `${already} already sent`,
  ].filter(Boolean);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const { sendResultsSms } = await gql(SEND_RESULTS_SMS, {
        input: { ...scope, student_ids: one ? [one.student_id] : null, resend: Boolean(ask.resend) },
      });
      onSent(sendResultsSms);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  const name = one ? `${one.first_name} ${one.last_name}` : null;
  const title = one
    ? (ask.resend ? `Send ${name}’s result again?` : `Text ${name}’s parent?`)
    : `Text ${plural(recipients, 'parent')}?`;

  return (
    <Dialog open title={title} onClose={onClose} busy={busy} labelId="sms-dialog-title">
      {!one && skipped.length > 0 && <p className="hint">Not included: {skipped.join(' · ')}.</p>}
      {one && ask.resend && <p className="hint">This parent was already sent this result{one.sms_at ? ` on ${shortDate(one.sms_at)}` : ''}. They will get it again.</p>}
      {!preview && !error && <p className="hint" role="status">Preparing the message…</p>}
      {preview && (
        <>
          <div>
            <div className="sms-preview-label">
              <b>Message</b>
              <span className="hint">
                {preview.student_name && !one ? `as ${preview.student_name}’s parent sees it · ` : ''}
                {plural(preview.segments, 'SMS', 'SMS')} per parent
              </span>
            </div>
            <p className="sms-preview">{preview.text}</p>
          </div>
          {preview.ready && preview.sandbox && (
            <Notice>Test mode: messages go to the SMS simulator or the local outbox, not to phones.</Notice>
          )}
          {!preview.ready && <Notice tone="error">{preview.problem}</Notice>}
        </>
      )}
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="row">
        <button type="button" className="btn" data-autofocus onClick={send}
          disabled={busy || !preview?.ready || recipients === 0}>
          {busy ? 'Sending…' : one ? 'Send' : `Send to ${plural(recipients, 'parent')}`}
        </button>
        <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </Dialog>
  );
}

export default function ReportCards() {
  const { actor, isAdmin } = useAuth();
  const { online } = useSync();
  const [params, setParams] = useSearchParams();
  const { terms, defaultTermId } = useTerms(actor.schoolId);
  const classes = useLive(() => db().classes.toArray(), [], []);

  const mine = useMemo(
    () => classes.filter((c) => isAdmin || c.is_class_teacher).sort(byClassOrder),
    [classes, isAdmin]
  );
  const termId = params.get('term') || defaultTermId;
  // Only the checkpoints this term held: a term without an Opener has no Opener report cards.
  const setup = useCheckpointSetup(actor.schoolId, termId);
  const checkpoint = setup.checkpoints.includes(params.get('cp')) ? params.get('cp') : 'ENDTERM';
  const classId = params.get('class') || mine[0]?.class_id || '';
  const go = (next) => setParams(Object.fromEntries(Object.entries({ term: termId, cp: checkpoint, class: classId, ...next }).filter(([, v]) => v)));

  const [cards, setCards] = useState([]);
  const [set, setSet] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [smsAsk, setSmsAsk] = useState(null);
  const [smsNotice, setSmsNotice] = useState(null);

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch(() => {});
  }, [actor.schoolId]);

  const load = useCallback(async () => {
    if (!classId || !termId) return;
    const scope = { school_id: actor.schoolId, class_id: classId, term_id: termId, checkpoint };
    const [{ listReportCards }, { listResultSets }] = await Promise.all([
      gql(LIST_REPORT_CARDS, scope),
      gql(LIST_RESULT_SETS, { school_id: actor.schoolId, class_id: classId, term_id: termId }),
    ]);
    setCards(listReportCards);
    setSet(listResultSets.find((s) => s.checkpoint === checkpoint) || null);
  }, [actor.schoolId, classId, termId, checkpoint]);

  useEffect(() => {
    setError(null);
    setSmsNotice(null);
    setCards([]);
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

  async function download(card) {
    const { requestReportCardDownload: link } = await gql(REQUEST_REPORT_CARD_DOWNLOAD, {
      input: { school_id: actor.schoolId, class_id: classId, term_id: termId, checkpoint, student_id: card.student_id },
    });
    save(link.url, link.file_name);
  }

  async function view(card) {
    const tab = window.open('about:blank', '_blank');

    if (!tab) {
      setError('Please allow pop-ups to view report cards.');
      return;
    }

    tab.opener = null;
    setBusy(`view-${card.student_id}`);
    setError(null);

    try {
      const { requestReportCardDownload: link } = await gql(
        REQUEST_REPORT_CARD_DOWNLOAD,
        {
          input: {
            school_id: actor.schoolId,
            class_id: classId,
            term_id: termId,
            checkpoint,
            student_id: card.student_id,
            inline: true,
          },
        }
      );

      tab.location.replace(link.url);
    } catch (e) {
      tab.close();
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function one(card) {
    setBusy(card.student_id);
    setError(null);
    try {
      await download(card);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function all() {
    const ready = cards.filter((c) => c.available);
    if (!window.confirm(`Download ${ready.length} report cards? Your browser may ask to allow several downloads.`)) return;
    setBusy('all');
    setError(null);
    try {
      for (const c of ready) {
        await download(c);
        await pause(400); // browsers drop downloads started too close together
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  // Stable between renders: the SMS dialog fetches its preview when this changes.
  const smsScope = useMemo(() => ({ school_id: actor.schoolId, class_id: classId, term_id: termId, checkpoint }), [actor.schoolId, classId, termId, checkpoint]);

  if (!online) return <Offline what="Downloading report cards" />;
  if (!isAdmin && mine.length === 0) {
    return <div className="notice">Report cards are available to administrators and class teachers.</div>;
  }

  const ready = cards.filter((c) => c.available).length;
  const className = mine.find((c) => c.class_id === classId)?.name || '';
  const smsCount = toSend(cards).length;

  return (
    <>
      <div className="page-head">
        <h1>Report cards</h1>
        <Select aria-label="Term" value={termId} onChange={(v) => go({ term: v })}
          options={terms.map((t) => ({ value: t.term_id, label: t.name }))} placeholder="Choose a term" />
        <Select aria-label="Checkpoint" value={checkpoint} onChange={(v) => go({ cp: v })}
          options={setup.checkpoints.map((c) => ({ value: c, label: setup.label(c) }))} />
        <Select aria-label="Class" value={classId} onChange={(v) => go({ class: v })}
          options={mine.map((c) => ({ value: c.class_id, label: classLabel(c, classes) }))} disabled={!isAdmin && mine.length === 1} />
      </div>

      {error && <div className="card error-card">{error}</div>}
      {smsNotice && <Notice tone={smsNotice.tone}>{smsNotice.text}</Notice>}
      {smsAsk && (
        <SmsDialog ask={smsAsk} cards={cards} scope={smsScope} onClose={() => setSmsAsk(null)}
          onSent={(outcome) => {
            setSmsAsk(null);
            setSmsNotice({ tone: outcome.failed || outcome.problem ? 'warn' : 'success', text: outcomeText(outcome) });
            load().catch((e) => setError(e.message));
          }} />
      )}

      <div className="budget-row">
        {set && <StatusPill status={set.status} />}
        {set?.status === 'PUBLISHED'
          ? <span>{ready} of {cards.length} report cards ready{checkpoint === 'ENDTERM' ? ' (official)' : ' (provisional)'}</span>
          : <span>{setup.label(checkpoint)} results for {className} are not published, so there are no report cards yet.</span>}
        {set?.status === 'PUBLISHED' && cards.length > 0 && <span className="grow" />}
        {set?.status === 'PUBLISHED' && cards.length > 0 && (
          <button type="button" className="btn secondary icon-text" disabled={busy !== null || smsCount === 0}
            title={smsCount === 0 ? 'Every parent with a number has this result. Use a row’s message button to send one again.' : undefined}
            onClick={() => { setSmsNotice(null); setSmsAsk({ card: null, resend: false }); }}>
            <ActionIcon name="message" />{`Text parents (${smsCount})`}
          </button>
        )}
        {ready > 0 && (
          <button type="button" className="btn" disabled={busy !== null} onClick={all}>
            {busy === 'all' ? 'Downloading' : `Download all (${ready})`}
          </button>
        )}
      </div>

      {cards.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Adm no</th><th>Student</th><th>Card</th><th>Parent SMS</th><th>Action</th></tr></thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.student_id}>
                  <td>{c.admission_no}</td>
                  <td>{c.first_name} {c.last_name}{c.student_status !== 'ACTIVE' && <span className="hint"> (deactivated)</span>}</td>
                  <td>{c.available ? (c.kind === 'OFFICIAL' ? 'Official' : 'Provisional') : <span className="hint">Being produced</span>}</td>
                  <td><SmsCell card={c} classId={classId} /></td>
                  <td className="actions">
                    <button type="button" className="btn link" title="View report card"
                      aria-label={`View report card for ${c.first_name} ${c.last_name}`} disabled={!c.available || busy !== null}
                      onClick={() => view(c)}
                    >
                      <ActionIcon name={busy === `view-${c.student_id}` ? 'loader' : 'eye'} />
                    </button>
                    <button type="button" className="btn link" disabled={!c.available || busy !== null}
                      aria-label={
                        busy === c.student_id
                          ? `Preparing report card for ${c.first_name} ${c.last_name}`
                          : `Download report card for ${c.first_name} ${c.last_name}`
                      }
                      title={busy === c.student_id ? 'Preparing' : 'Download'}
                      onClick={() => one(c)}
                    >
                      <ActionIcon name={busy === c.student_id ? 'loader' : 'download'} />
                    </button>
                    {reachable(c) && (
                      <button type="button" className="btn link" disabled={busy !== null || c.sms_status === 'SENDING'}
                        aria-label={`${c.sms_status === 'SENT' ? 'Send again to' : c.sms_status === 'FAILED' ? 'Try again for' : 'Text'} the parent of ${c.first_name} ${c.last_name}`}
                        title={c.sms_status === 'SENT' ? 'Send again' : c.sms_status === 'FAILED' ? 'Try again' : 'Text parent'}
                        onClick={() => { setSmsNotice(null); setSmsAsk({ card: c, resend: c.sms_status === 'SENT' }); }}
                      >
                        <ActionIcon name={c.sms_status === 'FAILED' ? 'refresh' : 'message'} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}