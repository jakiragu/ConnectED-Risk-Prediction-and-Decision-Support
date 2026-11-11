import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import dynalite from 'dynalite';
import { DynamoDBClient, CreateTableCommand, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { diff, remap, validate, equal } from './core.mjs';
const item=(sk,extra={})=>({PK:{S:'SCHOOL#demo'},SK:{S:sk},...extra});
const profile=item('SCHOOL#PROFILE');
test('set ordering is immaterial, list ordering is meaningful',()=>{
 assert(equal({x:{SS:['a','b']}},{x:{SS:['b','a']}}));
 assert(!equal({x:{L:[{S:'a'},{S:'b'}]}},{x:{L:[{S:'b'},{S:'a'}]}}));
});
test('diff protects profile and extra identities, removes demo additions',()=>{
 const teacher=item('TEACHER#extra',{entity:{S:'Teacher'}});
 const p=diff([profile,teacher,item('EXTRA')],[profile,item('BASE')]);
 assert.deepEqual(p.deletes,[item('EXTRA')]); assert.deepEqual(p.puts,[item('BASE')]);
});
test('remaps exact IDs and compound keys including nested authors',()=>{
 const r=remap([item('TEACHER#old',{school_id:{S:'demo'},a:{M:{by_sub:{S:'old'}}},b:{S:'old_suffix'},GSI1PK:{S:'SCHOOL#demo#CLASS#x'}})],'demo','target',[{source:'old',target:'new'}])[0];
 assert.equal(r.PK.S,'SCHOOL#target'); assert.equal(r.SK.S,'TEACHER#new'); assert.equal(r.a.M.by_sub.S,'new'); assert.equal(r.b.S,'old_suffix'); assert.equal(r.GSI1PK.S,'SCHOOL#target#CLASS#x');
});
test('rejects cross-school keys, duplicates and active prediction runs',()=>{
 assert.throws(()=>validate([profile,{...item('x'),PK:{S:'SCHOOL#other'}}],'demo'));
 assert.throws(()=>validate([profile,profile],'demo'));
 assert.throws(()=>validate([profile,item('RISKRUN#1',{entity:{S:'RiskRun'},status:{S:'RUNNING'}})],'demo'));
});
test('small seed has 40 students and only valid classes',async()=>{
 process.argv.push('--demo-small'); const s=await import('../../local/seed.js');
 assert.equal(s.students.length,40); assert.equal(s.classes.length,1);
 assert(s.students.every(x=>['cls_f4south','cls_test'].includes(x.class_id)));
 process.argv.pop();
});
test('CLI snapshot, dry run, restore, repeat, checksum rejection and school isolation',async()=>{
 const server=dynalite({createTableMs:0}); await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const endpoint=`http://127.0.0.1:${server.address().port}`;
 const client=new DynamoDBClient({region:'eu-west-1',endpoint,credentials:{accessKeyId:'local',secretAccessKey:'local'}});
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'connected-demo-'));
 const file=path.join(dir,'baseline.json'); const table='demo_test';
 const run=async(...args)=>new Promise(resolve=>{
   const p=spawn(process.execPath,['scripts/demo/data.mjs',...args,'--table',table,'--region','eu-west-1','--school','demo','--endpoint',endpoint,'--file',file],{cwd:process.cwd()});
   let out='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>out+=x);p.on('close',code=>resolve({code,out}));
 });
 try {
  await client.send(new CreateTableCommand({TableName:table,KeySchema:[{AttributeName:'PK',KeyType:'HASH'},{AttributeName:'SK',KeyType:'RANGE'}],AttributeDefinitions:[{AttributeName:'PK',AttributeType:'S'},{AttributeName:'SK',AttributeType:'S'}],ProvisionedThroughput:{ReadCapacityUnits:5,WriteCapacityUnits:5}}));
  const teacher=item('TEACHER#one',{entity:{S:'Teacher'},teacher_id:{S:'one'},email:{S:'one@example.test'},role:{S:'Admin'}});
  const score=item('SCORE#1',{marks:{N:'42'},flags:{SS:['b','a']},nested:{M:{num:{N:'1.234567890123456789'}}}});
  const other={...item('OTHER'),PK:{S:'SCHOOL#real'}};
  for(const Item of [profile,teacher,score,other]) await client.send(new PutItemCommand({TableName:table,Item}));
  const snap=await run('snapshot','--quiescent');assert.equal(snap.code,0,snap.out);
  for(const Item of [{...score,marks:{N:'99'}},item('ADDED')]) await client.send(new PutItemCommand({TableName:table,Item}));
  const preview=await run('restore'); assert.equal(preview.code,0,preview.out); assert.match(preview.out,/"put": 1/); assert.match(preview.out,/"delete": 1/);
  assert.equal((await run('restore','--apply')).code,1);
  const result=await run('restore','--apply','--confirm-table',table,'--quiescent','--backup-dir',dir);assert.equal(result.code,0,result.out);
  const get=async i=>(await client.send(new GetItemCommand({TableName:table,Key:{PK:i.PK,SK:i.SK},ConsistentRead:true}))).Item;
  assert(equal(await get(score),score));assert.deepEqual(await get(other),other);assert.equal(await get(item('ADDED')),undefined);
  const again=await run('restore'); assert.match(again.out,/"put": 0/);assert.match(again.out,/"delete": 0/);
  const broken=JSON.parse(await fs.readFile(file));broken.items[0].bad={S:'tampered'};await fs.writeFile(file,JSON.stringify(broken));
  assert.equal((await run('restore')).code,1);
 } finally {client.destroy();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});
