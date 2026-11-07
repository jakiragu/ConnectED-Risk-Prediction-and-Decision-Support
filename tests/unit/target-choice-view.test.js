import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

// Executes the actual component with a small hook harness; not a browser test.
function mount() {
  let state = null, dependency, effects = [];
  const context = {
    React: { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    useState: () => [state, value => { state = value; }],
    useEffect: (fn, deps) => { if (dependency !== deps[0]) { effects.push(fn); dependency = deps[0]; } },
  };
  const source = readFileSync('src/components/RiskExplanation.jsx', 'utf8').replace(/\r\n/g, '\n');
  for (const m of source.matchAll(/^import \{([^}]+)\} from .*;$/gm)) for (const n of m[1].split(',').map(x=>x.trim())) if (!(n in context)) context[n] = n;
  const script = transformSync(source.replace(/^import .*;\n/gm, '').replace(/export default /g,'').replace(/export /g,'') + '\nglobalThis.component = Targets;', { loader:'jsx', format:'cjs' }).code;
  vm.createContext(context); vm.runInContext(script,context);
  return props => { let tree=context.component(props); if(effects.length) { for(const fn of effects)fn();effects=[];tree=context.component(props); } return tree; };
}
const walk = node => node && typeof node === 'object' ? [node,...(node.children || []).flat(Infinity).flatMap(walk)] : [];
const text = node => node && typeof node === 'object' ? (node.children || []).flat(Infinity).map(text).join('') : String(typeof node === 'boolean' ? '' : node ?? '');
const options = [0,1,2].map(option_index=>({option_index,method:'dice-random',changes:[]}));
const targets = {status:'FOUND',selected_option:1,selection_saved:true,options};

test('saved option survives remount; preview does not save; explicit save submits stable option id',()=>{
  const render=mount();let saved=[];const props={targets,onSave:i=>saved.push(i)};
  let tree=render(props);
  assert.equal(text(walk(tree).find(n=>n.type==='button'&&n.props['aria-pressed'])),'Option 2 · Selected');
  walk(tree).find(n=>n.type==='button'&&text(n)==='Option 3').props.onClick();
  tree=render(props); assert.deepEqual(saved,[]);
  walk(tree).find(n=>n.type==='button'&&text(n)==='Select option 3').props.onClick();
  assert.deepEqual(saved,[2]);
  tree=mount()({targets:{...targets,selected_option:2},onSave:props.onSave});
  assert.equal(text(walk(tree).find(n=>n.type==='button'&&n.props['aria-pressed'])),'Option 3 · Selected');
});

test('offline save disabled; filtered-out selection and changed target states render safely',()=>{
  const render=mount();
  let tree=render({targets:{...targets,selection_saved:false,selected_option:2},onSave:()=>{},saveDisabled:true});
  assert.equal(walk(tree).find(n=>n.type==='button'&&text(n)==='Select option 3').props.disabled,true);
  tree=render({targets:{...targets,selected_option:2,options:options.slice(0,2)}});
  assert.match(text(tree),/selected option has no targets/);
  for(const status of ['MAINTAIN','NONE','ERROR','FOUND']) assert.doesNotThrow(()=>render({targets:{...targets,status}}));
  assert.doesNotThrow(()=>render({targets:{...targets,options:[options[0]]}}));
});


test('single DiCE and comparable-student targets have no choice controls or messages',()=>{
  for (const t of [
    {...targets,options:[options[0]],selected_option:0},
    {...targets,status:'FALLBACK',options:[{...options[0],method:'peer-progression'}],selected_option:0},
    {...targets,status:'FALLBACK'},
  ]) {
    const tree=mount()({targets:t,onSave:()=>{},saveDisabled:true});
    assert.equal(walk(tree).filter(n=>n.type==='button').length,0);
    assert.doesNotMatch(text(tree),/Selected|Default:|Preview only|Connect and|Select option/);
  }
});

test('saved choice hides save action; previewing another option reveals it',()=>{
  const render=mount();const props={targets,onSave:()=>{}};
  let tree=render(props);
  assert.equal(walk(tree).filter(n=>n.type==='button'&&text(n).startsWith('Select option')).length,0);
  walk(tree).find(n=>n.type==='button'&&text(n)==='Option 3').props.onClick();
  tree=render(props);
  assert.equal(walk(tree).filter(n=>n.type==='button'&&text(n)==='Select option 3').length,1);
});


test('history displays only the persisted option even when given a different preview',()=>{
  const history={...targets,options:options.map(o=>({...o,changes:[{column:'T2M_Math',kind:'subject',group:'Mathematics',from:40,to:50+o.option_index,gain:10+o.option_index}]}))};
  const tree=mount()({targets:history,selectedOnly:true,selectedIndex:2,onSelectedIndexChange:()=>{},onSave:()=>{}});
  assert.equal(walk(tree).filter(n=>n.type==='button').length,0);
  assert.match(text(tree),/Selected at the time/);
  assert.match(text(tree),/51/);
  assert.doesNotMatch(text(tree),/52/);
});

test('history never invents a selection or substitutes a filtered-out option',()=>{
  const missing=mount()({targets:{...targets,selection_saved:false},selectedOnly:true});
  assert.match(text(missing),/No selection recorded/);
  assert.equal(walk(missing).filter(n=>n.type==='table'||n.type==='button').length,0);
  const filtered=mount()({targets:{...targets,options:[options[0]]},selectedOnly:true});
  assert.match(text(filtered),/selected option has no targets/);
  assert.equal(walk(filtered).filter(n=>n.type==='button').length,0);
});
