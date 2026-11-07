import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import dynalite from 'dynalite';

const server = dynalite({ createTableMs: 0 });
const SCHOOL = 'target_choice_test';
let ddb, Put, keys, schema, graphql, ops, risk, token, scopeTargets, linkFor, selectedChanges;
let original;
const identity = (sub = 'admin') => ({ sub, claims: { 'custom:school_id': SCHOOL }, groups: [] });
const put = (Item) => ddb.send(new Put({ TableName: keys.TABLE, Item: { PK: keys.pk(SCHOOL), school_id: SCHOOL, ...Item } }));

before(async () => {
  await new Promise(r => server.listen(0, r));
  Object.assign(process.env, { DDB_ENDPOINT: `http://127.0.0.1:${server.address().port}`, GRADEBOOK_TABLE_NAME: 'target_choice_test', AWS_REGION: 'eu-west-1', EVENTS_ENDPOINT: 'http://127.0.0.1:9' });
  ({ ddb } = await import('../../backend/library/client.js'));
  ({ PutCommand: Put } = await import('@aws-sdk/lib-dynamodb'));
  keys = await import('../../backend/library/keys.js');
  const { CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const { StreamSpecification, ...table } = (await import('../../infra/table-definition.js')).TABLE_DEFINITION;
  await ddb.send(new CreateTableCommand(table));
  graphql = await import('graphql');
  const { createSchema } = await import('graphql-yoga');
  const { RESOLVERS } = await import('../../local/resolvers.js');
  const resolvers = Object.fromEntries(Object.entries(RESOLVERS).map(([parent, fields]) => [parent, Object.fromEntries(Object.entries(fields).map(([field, handler]) => [field, (_, args, ctx) => handler({ arguments: args, identity: ctx, info: { fieldName: field } })]))]));
  schema = createSchema({ typeDefs: readFileSync('graphql/schema/gradebook.graphql', 'utf8'), resolvers });
  ops = await import('../../src/api/decisionOperations.js');
  risk = await import('../../backend/library/riskRepo.js');
  ({ targetToken: token } = await import('../../backend/library/targetChoice.js'));
  ({ scopeTargets } = await import('../../backend/library/decisionSupport.js'));
  ({ linkFor } = await import('../../backend/library/riskProfile.js'));
  ({ selectedChanges } = await import('../../backend/library/targets.js'));
  await put({ SK: keys.sk.school(), name: 'Test school', status: 'ACTIVE' });
  await put({ SK: keys.sk.term('t1'), term_id: 't1', academic_year: 2026, term_number: 1, start_date: '2026-01-01', end_date: '2026-03-31' });
  await put({ SK: keys.sk.klass('c1'), class_id: 'c1', name: 'Form 2 East', year: 2026, status: 'CURRENT' });
  await put({ SK: keys.sk.student('s1'), student_id: 's1', class_id: 'c1', first_name: 'Test', last_name: 'Student', admission_no: '001', status: 'ACTIVE' });
  for (const [sub, role, class_teacher_of] of [['admin','Admin',null],['classTeacher','Teacher','c1'],['subjectTeacher','Teacher',null]]) {
    await put({ SK: keys.sk.teacher(sub), teacher_id: sub, role, status: 'ACTIVE', first_name: sub, class_teacher_of, assignments: [{ class_id:'c1', subject:'Mathematics' }] });
  }
  original = { school_id: SCHOOL, academic_year: 2026, prediction_point: 'T1M', student_id: 's1', class_id: 'c1', run_id: 'run1', model_version:'test-model', predicted_at:'2026-02-01T10:00:00Z', probability:0.8, threshold:0.5, at_risk:true,
    counterfactuals: { status:'FOUND', target_point:'T1F', options: [
      { method:'dice-random', score:0.4, at_risk:false, changes:[{feature:'T1F_Mathematics',from:40,to:55}] },
      { method:'dice-random', score:0.3, at_risk:false, changes:[{feature:'T1F_Mathematics',from:40,to:65},{feature:'T1F_English',from:45,to:60}] },
      { method:'dice-random', score:0.35, at_risk:false, changes:[{feature:'T1F_English',from:45,to:70}] },
    ] } };
  await risk.putPredictions(SCHOOL, [original]);
});
after(() => new Promise(r => server.close(r)));

async function run(document, variables, sub='admin') {
  const errors = graphql.validate(schema, graphql.parse(document));
  assert.deepEqual(errors, []);
  const result = await graphql.execute({ schema, document: graphql.parse(document), variableValues:variables, contextValue:identity(sub) });
  if (result.errors?.length) throw result.errors[0].originalError;
  return result.data;
}
const profile = async (sub='admin') => (await run(ops.GET_STUDENT_RISK_PROFILE, { school_id:SCHOOL, student_id:'s1' }, sub)).getStudentRiskProfile;
const choose = (option_index, expected_version, prediction_token=token(original), sub='admin', school_id=SCHOOL) => run(ops.SELECT_STUDENT_TARGET,{input:{school_id,student_id:'s1',option_index,expected_version,prediction_token}},sub);
const rejectsType = (fn,type) => assert.rejects(fn,e=>e.type===type);

test('persist selection through GraphQL; fresh reads and new intervention use it; historic intervention unchanged', async () => {
  assert.equal((await profile()).targets.selection_saved,false);
  const make = (id) => run(ops.SAVE_INTERVENTION,{input:{ school_id:SCHOOL,student_id:'s1',intervention_id:id,factor:'Mathematics',method:'Weekly support',frequency:'WEEKLY',status:'ONGOING',started_on:'2026-02-02' }});
  const old = (await make('old_intervention_01')).saveIntervention;
  assert.equal(old.linked.target.to,55);
  await choose(1,0);
  const fresh = await profile();
  assert.equal(fresh.targets.selected_option,1);
  assert.equal(fresh.assessment_history[0].targets.selected_option,1);
  assert.equal(fresh.assessment_history[0].targets.prediction_token,fresh.targets.prediction_token);
  assert.equal(fresh.targets.selection_version,1);
  assert.equal(fresh.targets.selection_saved,true);
  assert.equal(selectedChanges(fresh.targets)[0].to,65);
  const added = (await make('new_intervention_02')).saveIntervention;
  assert.equal(added.linked.target.to,65);
  const stored = await risk.getPrediction(SCHOOL,2026,'T1M','s1');
  assert.deepEqual(stored.counterfactuals,original.counterfactuals);
  assert.equal(stored.target_choice.updated_by,'admin');
  const records = (await run(ops.LIST_STUDENT_INTERVENTIONS,{school_id:SCHOOL,student_id:'s1'})).listStudentInterventions;
  assert.equal(records.find(i=>i.intervention_id===old.intervention_id).linked.target.to,55);
});

test('permissions, invalid indices and stale saves are refused', async () => {
  await rejectsType(()=>choose(0,1,token(original),'subjectTeacher'),'Forbidden');
  await rejectsType(()=>choose(0,1,token(original),'admin','another_school'),'Forbidden');
  await rejectsType(()=>choose(99,1),'ValidationError');
  await rejectsType(()=>choose(-1,1),'ValidationError');
  await rejectsType(()=>choose(0,0),'Conflict');
  await rejectsType(()=>choose(0,1,'stale-token'),'Conflict');
});

test('class teacher can switch; filtered subjects retain original option ids; no fallback to another option', async () => {
  await choose(2,1,token(original),'classTeacher');
  const partial = (await profile('subjectTeacher')).targets;
  assert.deepEqual(partial.options.map(o=>o.option_index),[0,1]);
  assert.equal(partial.selected_option,2);
  assert.deepEqual(selectedChanges(partial),[]);
  const stored = await risk.getPrediction(SCHOOL,2026,'T1M','s1');
  assert.equal(linkFor(stored,'Mathematics').target,null);
  assert.equal(linkFor(stored,'English').target.to,70);
});

test('only one simultaneous versioned save succeeds', async () => {
  const responses = await Promise.allSettled([choose(0,2),choose(1,2)]);
  assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(responses.find(r=>r.status==='rejected').reason.type,'Conflict');
});

test('inactive students cannot change choice; regenerated predictions reset and reject old token', async () => {
  await put({ SK:keys.sk.student('s1'),student_id:'s1',class_id:'c1',status:'INACTIVE' });
  await rejectsType(()=>choose(0,3),'ValidationError');
  await put({ SK:keys.sk.student('s1'),student_id:'s1',class_id:'c1',first_name:'Test',last_name:'Student',status:'ACTIVE' });
  await risk.putPredictions(SCHOOL,[{...original,run_id:'run2'}]);
  const fresh = await profile();
  assert.equal(fresh.targets.selection_saved,false);
  assert.equal(fresh.targets.selected_option,0);
  await rejectsType(()=>choose(0,3),'Conflict');
  await choose(1,0,fresh.targets.prediction_token);
  assert.equal((await profile()).targets.selected_option,1);
});


test('new checkpoint has its own default; earlier comparison retains its saved choice', async () => {
  await risk.putPredictions(SCHOOL,[{...original,prediction_point:'T1F',run_id:'run3'}]);
  const fresh = await profile();
  assert.equal(fresh.latest.prediction_point,'T1F');
  assert.equal(fresh.targets.selected_option,0);
  assert.equal(fresh.targets.selection_saved,false);
  const older = fresh.assessment_history.find(e=>e.prediction.prediction_point==='T1M');
  assert.equal(older.targets.selected_option,1);
  assert.equal(older.targets.selection_saved,true);
  await rejectsType(()=>choose(2,1,older.targets.prediction_token),'Conflict');
});
