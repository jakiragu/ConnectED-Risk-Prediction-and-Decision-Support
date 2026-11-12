import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayPhone, normalisePhone } from '../../backend/library/student.js';
import { phoneHint, resultsSmsText, segments, subjectCodes, toGsm } from '../../backend/library/resultsSms.js';
import { readiness, sendSms, transport } from '../../backend/library/sms.js';
import { STATUS, checkStudentRows, parseCsv } from '../../backend/library/csvImport.js';

// ------------------------------------------------------------------ phone numbers

test('phone: Kenyan numbers typed the local ways all become +254…', () => {
  for (const typed of ['0712345678', '0712 345 678', '712345678', '254712345678', '+254 712 345 678', '+254-712-345-678', '(0712) 345678']) {
    assert.equal(normalisePhone(typed), '+254712345678', typed);
  }
  assert.equal(normalisePhone('0110 123 456'), '+254110123456');
});

test('phone: other countries need their + and code; empty means none', () => {
  assert.equal(normalisePhone('+256 712 345 678'), '+256712345678');
  assert.equal(normalisePhone('+250 788 123 456'), '+250788123456');
  assert.equal(normalisePhone(''), null);
  assert.equal(normalisePhone('   '), null);
  assert.equal(normalisePhone(null), null);
});

test('phone: wrong numbers are refused with a reason', () => {
  assert.throws(() => normalisePhone('0212345678'), /Kenyan mobile/);
  assert.throws(() => normalisePhone('07123'), /mobile number/);
  assert.throws(() => normalisePhone('0712abc678'), /digits/);
  assert.throws(() => normalisePhone('+12'), /too short/);
});

test('phone: shown the local way, and only its last digits in delivery records', () => {
  assert.equal(displayPhone('+254712345678'), '0712 345 678');
  assert.equal(displayPhone('+256712345678'), '+256712345678');
  assert.equal(displayPhone(null), '');
  assert.equal(phoneHint('+254712345678'), '…678');
});

// ------------------------------------------------------------------ message text

const student = { first_name: 'Achieng', last_name: 'Otieno', admission_no: '4512' };
const names = { schoolName: 'Greenfield High', className: 'Form 3 East', termName: 'Term 3 2026' };
const paper = [{ assessment_id: 'a' }];

test('sms text: an interim exam shows percentages and no grades', () => {
  const set = { kind: 'INTERIM', checkpoint: 'MIDTERM' };
  const row = {
    checkpoint_average: 63.25,
    subjects: [
      { subject: 'English', papers: paper, score: 70 },
      { subject: 'Mathematics', papers: paper, score: 56.5 },
      { subject: 'Kiswahili', papers: paper, score: null },
      { subject: 'Art', papers: [], score: null }, // not examined at this checkpoint
    ],
  };
  const text = resultsSmsText({ set, row, student, ...names });
  assert.equal(text,
    'Greenfield High: Term 3 2026 Mid-term exam results for Achieng Otieno (4512), Form 3 East. '
    + 'Mean 63.3%. English 70%, Mathematics 56.5%, Kiswahili -. Full report card from the school.');
  assert.doesNotMatch(text, /\b[A-E][+-]?\b(?=,|\.)/); // no grades on an interim result
});

test('sms text: end of term shows term scores, grades and the mean grade', () => {
  const set = { kind: 'FINAL', checkpoint: 'ENDTERM', basis_labels: { ENDTERM: 'End-term' } };
  const row = {
    term_average: 61, term_grade: 'B-',
    subjects: [
      { subject: 'English', papers: paper, term: { term_score: 70, grade: 'B+' } },
      { subject: 'Chemistry', papers: paper, term: { term_score: 52, grade: 'C' } },
    ],
  };
  assert.equal(resultsSmsText({ set, row, student, ...names }),
    'Greenfield High: Term 3 2026 End-term results for Achieng Otieno (4512), Form 3 East. '
    + 'Mean 61 B-. English 70 B+, Chemistry 52 C. Full report card from the school.');
});

test('sms text: long subject lists switch to unique short codes and stay within two SMS', () => {
  const many = ['English', 'Kiswahili', 'Mathematics', 'Biology', 'Chemistry', 'Physics', 'History and Government',
    'Geography', 'Christian Religious Education', 'Business Studies', 'Computer Studies', 'Agriculture'];
  const set = { kind: 'FINAL', checkpoint: 'ENDTERM' };
  const row = { term_average: 58.4, term_grade: 'C+', subjects: many.map((s) => ({ subject: s, papers: paper, term: { term_score: 58, grade: 'C+' } })) };
  const text = resultsSmsText({ set, row, student, ...names });
  assert.match(text, /ENG 58 C\+, KIS 58 C\+, MAT 58 C\+/);
  assert.ok(segments(text) <= 2, `${segments(text)} SMS: ${text}`);
  const codes = [...subjectCodes(['Chemistry', 'Christian Religious Education', 'Computer Studies', 'Commerce']).values()];
  assert.equal(new Set(codes).size, codes.length);
});

test('sms text: kept to the GSM alphabet so one SMS holds 160 characters', () => {
  assert.equal(toGsm('Wanjiru’s “mid–term” … Zoë'), 'Wanjiru\'s "mid-term" ... Zoe');
  assert.equal(segments('x'.repeat(160)), 1);
  assert.equal(segments('x'.repeat(161)), 2);
  assert.equal(segments('x'.repeat(306)), 2);
  assert.equal(segments('x'.repeat(307)), 3);
});

// ------------------------------------------------------------------ transport

const AT = { AT_USERNAME: 'connected', AT_API_KEY: 'key', SMS_TRANSPORT: 'africastalking' };
const reply = (status, body) => async () => ({ status, ok: status < 400, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const recipient = (statusCode, status) => ({ SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ statusCode, status, number: '+254712345678', cost: 'KES 0.8000', messageId: 'ATXid_1' }] } });

test('transport: chosen from the environment', () => {
  assert.equal(transport({ DDB_ENDPOINT: 'http://localhost:8000' }), 'log');
  assert.equal(transport({ AT_USERNAME: 'x', AT_API_KEY: 'y' }), 'africastalking');
  assert.equal(transport({}), 'off');
  assert.equal(transport({ SMS_TRANSPORT: 'off', AT_USERNAME: 'x', AT_API_KEY: 'y' }), 'off');
  assert.deepEqual(readiness({}), { ready: false, sandbox: false, problem: 'SMS is not set up on this deployment yet.' });
  assert.equal(readiness({ AT_USERNAME: 'sandbox', AT_API_KEY: 'k' }).sandbox, true);
});

test('transport: an accepted message, sent to the sandbox or live endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return reply(201, recipient(101, 'Success'))(); };
  const live = await sendSms({ to: '+254712345678', text: 'hi' }, { env: { ...AT, AT_SENDER_ID: 'GREENFIELD' }, fetchImpl });
  assert.deepEqual(live, { sent: true, provider_id: 'ATXid_1', cost: 'KES 0.8000', problem: null });
  assert.equal(calls[0].url, 'https://api.africastalking.com/version1/messaging');
  assert.equal(calls[0].init.headers.apiKey, 'key');
  assert.equal(calls[0].init.body.get('from'), 'GREENFIELD');
  await sendSms({ to: '+254712345678', text: 'hi' }, { env: { ...AT, AT_USERNAME: 'sandbox' }, fetchImpl });
  assert.equal(calls[1].url, 'https://api.sandbox.africastalking.com/version1/messaging');
});

test('transport: a refused number fails that message only; no credit or a wrong key stops the batch', async () => {
  const bad = await sendSms({ to: '+254712345678', text: 'hi' }, { env: AT, fetchImpl: reply(201, recipient(403, 'InvalidPhoneNumber')) });
  assert.equal(bad.sent, false);
  assert.equal(bad.fatal, false);
  assert.match(bad.problem, /not a valid mobile number/);

  const broke = await sendSms({ to: '+254712345678', text: 'hi' }, { env: AT, fetchImpl: reply(201, recipient(405, 'InsufficientBalance')) });
  assert.equal(broke.fatal, true);
  assert.match(broke.problem, /run out of credit/);

  const noRecipients = await sendSms({ to: '+254712345678', text: 'hi' }, { env: AT, fetchImpl: reply(201, { SMSMessageData: { Message: 'InsufficientBalance', Recipients: [] } }) });
  assert.equal(noRecipients.fatal, true);

  const auth = await sendSms({ to: '+254712345678', text: 'hi' }, { env: AT, fetchImpl: reply(401, 'The supplied authentication is invalid') });
  assert.equal(auth.fatal, true);
  assert.match(auth.problem, /account details/);

  const down = await sendSms({ to: '+254712345678', text: 'hi' }, { env: AT, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(down.sent, false);
  assert.equal(down.fatal, true);
});

test('transport: off never throws', async () => {
  const off = await sendSms({ to: '+254712345678', text: 'hi' }, { env: { SMS_TRANSPORT: 'off' } });
  assert.equal(off.sent, false);
  assert.equal(off.fatal, true);
});

// ------------------------------------------------------------------ CSV import

const classes = [{ class_id: 'c3e', name: 'Form 3 East', status: 'CURRENT' }];
const csv = (lines) => parseCsv(['admission_no,first_name,last_name,class,guardian_name,guardian_phone', ...lines].join('\n'));

test('csv: a new student brings their guardian contact, phone stored in international form', () => {
  const { rows } = checkStudentRows(csv(['4512,Amina,Wanjiru,Form 3 East,Grace Wanjiru,0712 345 678']), { classes });
  assert.equal(rows[0].status, STATUS.READY);
  assert.deepEqual(rows[0].input, {
    class_id: 'c3e', first_name: 'Amina', last_name: 'Wanjiru', admission_no: '4512', guardian_name: 'Grace Wanjiru', guardian_phone: '+254712345678',
  });
});

test('csv: a student already there gets a new number added; same number or none is skipped', () => {
  const students = [
    { student_id: 's1', admission_no: '4512', first_name: 'Amina', last_name: 'Wanjiru', class_id: 'c3e', status: 'ACTIVE', _version: 3 },
    { student_id: 's2', admission_no: '4513', first_name: 'Brian', last_name: 'Otieno', class_id: 'c3e', status: 'ACTIVE', guardian_phone: '+254722000111', _version: 1 },
    { student_id: 's3', admission_no: '4514', first_name: 'Cyn', last_name: 'Wanjiku', class_id: 'c3e', status: 'ACTIVE', _version: 1 },
  ];
  const { rows } = checkStudentRows(csv([
    '4512,Amina,Wanjiru,Form 3 East,Grace Wanjiru,0712 345 678',
    '4513,Brian,Otieno,Form 3 East,,0722 000 111',
    '4514,Cyn,Wanjiku,Form 3 East,,',
  ]), { classes, students });
  assert.equal(rows[0].status, STATUS.READY);
  assert.deepEqual(rows[0].input, { student_id: 's1', _version: 3, guardian_name: 'Grace Wanjiru', guardian_phone: '+254712345678' });
  assert.match(rows[0].message, /parent contact added/);
  assert.equal(rows[1].status, STATUS.SKIP);
  assert.equal(rows[2].status, STATUS.SKIP);
});

test('csv: a wrong guardian number is a row to fix; the columns are optional', () => {
  const { rows } = checkStudentRows(csv(['4512,Amina,Wanjiru,Form 3 East,,0212 345 678']), { classes });
  assert.equal(rows[0].status, STATUS.ERROR);
  assert.match(rows[0].message, /Kenyan mobile/);
  const plain = checkStudentRows(parseCsv('admission_no,first_name,last_name,class\n4512,Amina,Wanjiru,Form 3 East'), { classes });
  assert.equal(plain.rows[0].status, STATUS.READY);
});
