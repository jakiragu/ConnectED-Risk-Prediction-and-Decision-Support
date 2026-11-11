#!/usr/bin/env node
// Deliberately does NOT load .env: local endpoints must never leak into AWS resets.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { DynamoDBClient, DescribeTableCommand, QueryCommand, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient, AdminGetUserCommand, AdminListGroupsForUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { value, key, canonical, validate, diff, remap, protectedItem } from './core.mjs';
const { values: a, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries([
  ...['table','region','school','file','endpoint','map','pool','confirm-table','backup-dir'].map(k => [k,{type:'string'}]),
  ...['apply','quiescent','help'].map(k => [k,{type:'boolean'}]),
]) });
const help = `node scripts/demo/data.mjs snapshot|restore --table TABLE --region REGION --school ID --file baseline.json
  snapshot: save a school baseline. Existing files are never overwritten.
  restore: preview by default; add --apply --confirm-table TABLE --quiescent to write.
  --map accounts.json --pool SCHOOL_POOL maps source teacher emails to existing AWS emails.
  --endpoint http://localhost:8000 is for local export/testing only (no dotenv).
  --backup-dir PATH defaults to .demo-backups (before every restore).
Close all app tabs, clear offline storage, and drain background jobs before any snapshot/restore.
See docs/AWS-DEMO-DATA.md for setup, limitations and complete commands.`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digest = items => createHash('sha256').update(JSON.stringify(canonical(items))).digest('hex');
const binaryJSON = (_k,v) => v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v;
async function save(file, obj) {
  await fs.mkdir(path.dirname(path.resolve(file)), {recursive:true});
  await fs.writeFile(file, JSON.stringify(obj, binaryJSON, 2)+'\n', {flag:'wx',mode:0o600});
}
async function main() {
  if (a.help) return console.log(help);
  if (!['snapshot','restore'].includes(positionals[0]) || !a.table || !a.region || !a.school || !a.file) throw Error(help);
  if (a.endpoint && !['localhost','127.0.0.1','[::1]'].includes(new URL(a.endpoint).hostname)) throw Error('Custom endpoints must be loopback');
  const local = !!a.endpoint;
  const client = new DynamoDBClient({region:a.region,maxAttempts:10,...(local ? {endpoint:a.endpoint,credentials:{accessKeyId:'local',secretAccessKey:'local'}}:{})});
  const {Table:t} = await client.send(new DescribeTableCommand({TableName:a.table}));
  if (positionals[0] === 'restore' && t.StreamSpecification?.StreamEnabled) throw Error('Streams enabled: cannot guarantee restores will not trigger consumers');
  if (!t.KeySchema.some(k=>k.AttributeName==='PK' && k.KeyType==='HASH') || !t.KeySchema.some(k=>k.AttributeName==='SK' && k.KeyType==='RANGE')) throw Error('Unexpected table schema');
  console.log(JSON.stringify({tableArn:t.TableArn,school:a.school,billing:t.BillingModeSummary?.BillingMode || 'PROVISIONED',capacity:[t,...(t.GlobalSecondaryIndexes||[])].map(x=>({name:x.IndexName||'table',...x.ProvisionedThroughput}))},null,2));
  async function read() {
    const items=[]; let cursor;
    do {
      const r=await client.send(new QueryCommand({TableName:a.table,ConsistentRead:true,KeyConditionExpression:'PK = :p',ExpressionAttributeValues:{':p':{S:`SCHOOL#${a.school}`}},ExclusiveStartKey:cursor,Limit:10,ReturnConsumedCapacity:'TOTAL'}));
      // Convert binary AttributeValues to portable base64 before checksumming.
      items.push(...JSON.parse(JSON.stringify(r.Items||[],binaryJSON))); cursor=r.LastEvaluatedKey;
      if (!local) await sleep(Math.max(250,(r.ConsumedCapacity?.CapacityUnits||1)*350));
    } while(cursor);
    items.sort((x,y)=>key(x).localeCompare(key(y)));
    validate(items,a.school); return items;
  }
  const current=await read();
  const snapshot = items => ({format:'connected-demo-v1',school:a.school,tableArn:t.TableArn,createdAt:new Date().toISOString(),sha256:digest(items),items});
  if (positionals[0]==='snapshot') {
    if (!a.quiescent) throw Error('Snapshot requires --quiescent after closing clients and draining background jobs');
    await save(a.file,snapshot(current));
    console.log(`Saved ${current.length} items to ${a.file}. Treat this as the immutable baseline.`); return;
  }
  const baseline=JSON.parse(await fs.readFile(a.file,'utf8'));
  if (baseline.format!=='connected-demo-v1' || digest(baseline.items)!==baseline.sha256) throw Error('Invalid snapshot format or checksum');
  validate(baseline.items,baseline.school);
  const sourceTeachers=baseline.items.filter(i=>value(i,'entity')==='Teacher');
  const targetTeachers=current.filter(i=>value(i,'entity')==='Teacher');
  if (!sourceTeachers.length) throw Error('Baseline has no teachers');
  let desired=baseline.items;
  if (a.map) {
    const mapping=JSON.parse(await fs.readFile(a.map,'utf8'));
    if (!a.pool || local) throw Error('Cross-environment mapping requires an AWS SchoolPoolId');
    const cognito=new CognitoIdentityProviderClient({region:a.region});
    const pairs=[]; const targets=new Set();
    for(const source of sourceTeachers) {
      const email=mapping[value(source,'email')];
      const matches=targetTeachers.filter(i=>value(i,'email')?.toLowerCase()===email?.toLowerCase());
      if (!email || matches.length!==1) throw Error(`Map ${value(source,'email')} to exactly one existing teacher in the target school`);
      const target=matches[0]; const sub=value(target,'teacher_id');
      if (targets.has(sub)) throw Error('Two source teachers cannot map to the same target'); targets.add(sub);
      const u=await cognito.send(new AdminGetUserCommand({UserPoolId:a.pool,Username:email}));
      const attrs=Object.fromEntries(u.UserAttributes.map(x=>[x.Name,x.Value]));
      const groups=await cognito.send(new AdminListGroupsForUserCommand({UserPoolId:a.pool,Username:email}));
      if (!u.Enabled || attrs.sub!==sub || attrs['custom:school_id']!==a.school || value(target,'status')!=='ACTIVE' || value(target,'role')!==value(source,'role') || !groups.Groups?.some(g=>g.GroupName===value(source,'role'))) throw Error(`Account/role/school mismatch: ${email}`);
      pairs.push({source:value(source,'teacher_id'),target:sub,profile:target});
    }
    desired=remap(baseline.items,baseline.school,a.school,pairs);
    // Local PDF pointers/Step Functions ARNs cannot be used by the AWS stack.
    desired=desired.filter(i=>!value(i,'SK').startsWith('REPORTCARD#') && !value(i,'SK').startsWith('RCDOWNLOAD#'));
    desired=desired.map(i=>{
      if(!value(i,'SK').startsWith('RESULTSET#') || value(i,'status')!=='PUBLISHED') return i;
      const out={...i,report_cards_status:{S:'FAILED'},report_error:{S:'Demo import: PDFs were not migrated. Retry report generation if needed.'}};
      for(const f of ['report_execution','report_started_at','report_finished_at']) delete out[f];
      return out;
    });
    desired=desired.map(i=>{
      if (value(i,'entity')!=='Teacher') return i;
      const existing=pairs.find(p=>p.target===value(i,'teacher_id')).profile;
      // Keep actual names/email/status; only restore demo assignments.
      const out={...existing};
      for (const field of ['assignments','class_teacher_of']) { if (i[field]) out[field]=i[field]; else delete out[field]; }
      return out;
    });
  } else {
    if (baseline.school!==a.school || (!local && baseline.tableArn!==t.TableArn)) throw Error('Cross-school/table import needs --map and --pool');
    for(const source of sourceTeachers) {
      const existing=targetTeachers.find(i=>value(i,'teacher_id')===value(source,'teacher_id'));
      if (!existing || value(existing,'email')!==value(source,'email') || value(existing,'role')!==value(source,'role')) throw Error('Teacher identity changed; fix accounts separately before reset');
    }
    // Identity/profile changes are not reset. Restore assignments only.
    desired=desired.map(i=>{
      if(value(i,'entity')!=='Teacher') return i;
      const out={...targetTeachers.find(t=>value(t,'teacher_id')===value(i,'teacher_id'))};
      for(const f of ['assignments','class_teacher_of']) { if(i[f]) out[f]=i[f]; else delete out[f]; }
      return out;
    });
  }
  validate(desired,a.school);
  const plan=diff(current,desired);
  console.log(JSON.stringify({put:plan.puts.length,delete:plan.deletes.length,unchanged:plan.unchanged,entitiesToWrite:plan.puts.reduce((o,i)=>(o[value(i,'entity')]=(o[value(i,'entity')]||0)+1,o),{})},null,2));
  if (!a.apply) return console.log('PREVIEW ONLY. No writes made.');
  if(a['confirm-table']!==a.table || !a.quiescent) throw Error('Writes require --confirm-table matching --table and --quiescent');
  const backup=path.join(a['backup-dir']||'.demo-backups',`before-${Date.now()}-${process.pid}.json`);
  await save(backup,snapshot(current)); console.log(`Recovery snapshot: ${backup}`);
  const deserialize = obj => {
    if(Array.isArray(obj)) return obj.map(deserialize);
    if(obj && typeof obj==='object') return Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,k==='B'?Buffer.from(v,'base64'):k==='BS'?v.map(x=>Buffer.from(x,'base64')):deserialize(v)]));
    return obj;
  };
  // Sequential writes with consumed-capacity pacing handle large SHAP/DiCE items.
  // At most ~2 WCUs/s per table/index; SDK retries throttling. No API/publish calls.
  const operations=[...plan.puts.map(Item=>new PutItemCommand({TableName:a.table,Item:deserialize(Item),ReturnConsumedCapacity:'INDEXES'})),...plan.deletes.map(i=>new DeleteItemCommand({TableName:a.table,Key:{PK:i.PK,SK:i.SK},ReturnConsumedCapacity:'INDEXES'}))];
  let done=0;
  for(const op of operations) {
    const r=await client.send(op); const c=r.ConsumedCapacity;
    const units=Math.max(c?.Table?.CapacityUnits||1,...Object.values(c?.GlobalSecondaryIndexes||{}).map(x=>x.CapacityUnits||0));
    if(!local) await sleep(Math.max(500,units*500));
    if(++done%100===0 || done===operations.length) console.log(`${done}/${operations.length} writes complete`);
  }
  const after=await read(); const remaining=diff(after,desired);
  if(remaining.puts.length || remaining.deletes.length) throw Error('Verification failed: concurrent work or incomplete restore. Keep clients closed and rerun.');
  console.log('Verified baseline restored. Allow indexes to catch up, then reopen with cleared site storage.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
