import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { profileAssessments } from '../../src/profileComparison.js';
import { CHECKPOINT_ORDER } from '../../backend/library/decisionSupport.js';

const walk = n => n && typeof n === 'object' ? [n,...(n.children || []).flat(Infinity).flatMap(walk)] : [];
function setup({ all=true, current=true, online=true, count=2 }={}) {
  const target = (token,selected_option) => ({status:'FOUND',prediction_token:token,selected_option,selection_saved:true,selection_version:1,options:[0,1,2].map(option_index=>({option_index,changes:[]}))});
  const profile={student:{student_id:'s',status:'ACTIVE'},academic_year:2026,available_years:[2026],scope:{all,factors:['Mathematics']},current,
    latest:{prediction_point:'T1F'},targets:target('new',1),risk_trend:[],performance_trend:[{point:'T1M',subjects:[{subject:'Mathematics',score:40}]}],interventions:[],
    assessment_history:[{prediction:{prediction_point:'T1M'},targets:target('old',2)},{prediction:{prediction_point:'T1F'},targets:target('new',1)}]};
  profile.assessment_history = profile.assessment_history.slice(-count);
  const state=[{data:profile},null,false,null,false,null,null,null,false,'']; let i=0;const ref={};const requests=[];
  const source=readFileSync('src/pages/StudentProfile.jsx','utf8').replace(/\r\n/g,'\n');
  const ctx={React:{Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props||{},children})},
    useState:()=>{const k=i++;return [state[k],v=>{state[k]=typeof v==='function'?v(state[k]):v;}];},useRef:()=>ref,useEffect:()=>{},
    useParams:()=>({studentId:'s'}),useAuth:()=>({actor:{schoolId:'school'}}),useSync:()=>({online}),useNavigate:()=>()=>{},useLocation:()=>({}),
    profileAssessments,CHECKPOINT_ORDER,backTo:()=>'/dashboard',
    gql:async(doc,{input})=>{requests.push(input);return {selectStudentTarget:{...input,selected_option:input.option_index,selection_version:2,selection_saved:true}};},
  };
  for(const m of source.matchAll(/^import \{([^}]+)\} from .*;$/gm))for(const n of m[1].split(',').map(x=>x.trim()))if(!(n in ctx))ctx[n]=n;
  for(const m of source.matchAll(/^import (\w+) from .*;$/gm))ctx[m[1]]=m[1];
  const code=transformSync(source.replace(/^import .*;\n/gm,'').replace('export default function','function')+'\nglobalThis.component=StudentProfile;', {loader:'jsx',format:'cjs'}).code;
  vm.createContext(ctx);vm.runInContext(code,ctx);
  return {render:()=>{i=0;return ctx.component();},state,requests};
}
const later=tree=>walk(tree).find(n=>n.type?.name==='AssessmentPanel'&&n.props.heading!=='Earlier assessment');
const earlier=tree=>walk(tree).find(n=>n.type?.name==='AssessmentPanel'&&n.props.heading==='Earlier assessment');
const toggle=tree=>walk(tree).find(n=>n.type==='button'&&n.props['aria-controls']==='assessment-panels');
const chart=tree=>walk(tree).find(n=>n.type==='SubjectPerformanceChart');

test('comparison defaults and chart use saved choice; saving updates current history only',async()=>{
  const app=setup();let tree=app.render();
  assert.equal(chart(tree).props.targetOption.option_index,1);
  assert.equal(earlier(tree),undefined);
  toggle(tree).props.onClick();tree=app.render();
  assert.equal(earlier(tree).props.targetIndex,2);
  assert.equal(earlier(tree).props.selectedOnly,true);
  later(tree).props.onTargetIndexChange(2);tree=app.render();
  assert.equal(chart(tree).props.targetOption.option_index,2);
  await later(tree).props.onSaveTarget(2);
  assert.equal(app.requests[0].prediction_token,'new');
  assert.equal(app.state[0].data.targets.selected_option,2);
  assert.equal(app.state[0].data.assessment_history[1].targets.selected_option,2);
  assert.equal(app.state[0].data.assessment_history[0].targets.prediction_token,'old');
  assert.equal(app.state[0].data.assessment_history[0].targets.selection_version,1);
});

test('historical panels and subject teachers cannot save; offline button disabled',()=>{
  const app=setup();let tree=app.render();toggle(tree).props.onClick();tree=app.render();
  assert.equal(earlier(tree).props.onSaveTarget,undefined);
  assert.equal(later(setup({all:false}).render()).props.onSaveTarget,undefined);
  assert.equal(later(setup({current:false}).render()).props.onSaveTarget,undefined);
  assert.equal(later(setup({online:false}).render()).props.targetSaveDisabled,true);
});


test('comparison is opt-in, preserves the current selection and closes to full width',()=>{
  const app=setup();let tree=app.render();
  assert.equal(toggle(tree).props['aria-expanded'],false);
  assert.equal(earlier(tree),undefined);
  assert.equal(later(tree).props.onChange,undefined);
  later(tree).props.onTargetIndexChange(2);
  toggle(tree).props.onClick();tree=app.render();
  assert.equal(toggle(tree).props['aria-expanded'],true);
  assert.ok(earlier(tree));
  assert.match(walk(tree).find(n=>n.props.id==='assessment-panels').props.className,/is-comparing/);
  earlier(tree).props.onChange('T1M');
  toggle(tree).props.onClick();tree=app.render();
  assert.equal(earlier(tree),undefined);
  assert.doesNotMatch(walk(tree).find(n=>n.props.id==='assessment-panels').props.className,/is-comparing/);
  assert.equal(later(tree).props.targetIndex,2);
  assert.equal(app.requests.length,0);
});

test('one checkpoint offers no comparison; read-only profiles hide target choices',()=>{
  const tree=setup({count:1}).render();
  assert.equal(toggle(tree),undefined);
  assert.equal(earlier(tree),undefined);
  assert.equal(later(setup({all:false}).render()).props.selectedOnly,true);
  assert.equal(later(setup({current:false}).render()).props.selectedOnly,true);
});


test('both comparison checkpoint pickers remain available and closing restores latest',()=>{
 const app=setup(); let tree=app.render();
 toggle(tree).props.onClick();tree=app.render();
 assert.equal(typeof later(tree).props.onChange,'function');
 assert.equal(typeof earlier(tree).props.onChange,'function');
 assert.deepEqual(Array.from(later(tree).props.options,o=>o.value),['T1F']);
 assert.deepEqual(Array.from(earlier(tree).props.options,o=>o.value),['T1M']);
 toggle(tree).props.onClick();tree=app.render();
 assert.equal(later(tree).props.value,'T1F');
 assert.equal(later(tree).props.onChange,undefined);
});
