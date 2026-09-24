/* Fly Mario UI/bridge. Real connectome runs in fly-worker.js. */
(()=>{'use strict';
const COMMIT='03358c075000af5379e405b244dd31f1a0fd1401',BASE=`https://raw.githubusercontent.com/alextitonis/fly.ai/${COMMIT}/world/public/connectome/`;
const st={ready:false,loading:false,error:null,progress:'',backend:'offline',neurons:0,connections:0,out:{forward:0,backward:0,steer:0,jump:0,attack:0,primitive:'idle'},tel:null,ctx:{strain:'explore',phase:'base',assist:.68,targetMode:'auto'}};
let w,panel,seq=0,loading;const waits=new Map,S=x=>Math.max(-1,Math.min(1,Number.isFinite(x)?x:0));
function snap(){return{ready:st.ready,loading:st.loading,error:st.error,progress:st.progress,backend:st.backend,neurons:st.neurons,connections:st.connections,output:st.out,telemetry:st.tel,context:{...st.ctx}}}
function emit(){dispatchEvent(new CustomEvent('flymario-status',{detail:snap()}))}
function failWorker(err){
  const e=err instanceof Error?err:Error(String(err||'Fly worker failed'));
  st.error=e.message;st.loading=false;st.ready=false;
  status('❌ '+e.message);refresh();emit();
  const reject=st._bad;st._ok=st._bad=null;
  if(reject)reject(e);
  for(const[id,q]of waits){
    waits.delete(id);
    clearTimeout(q.timer);
    q.reject(e);
  }
}
function worker(){
  if(w)return w;
  try{w=new Worker('./fly-worker.js',{name:'fly-mario-malecns'})}catch(err){w=null;throw err}
  w.onmessage=({data:m})=>{
    if(m.type==='progress'){st.progress=m.text;status(m.text);emit()}
    else if(m.type==='ready'){
      Object.assign(st,{ready:true,loading:false,error:null,progress:'ready',backend:'MaleCNS v1.0 / worker',neurons:m.neurons,connections:m.connections});
      status('🪰 MaleCNS ready');refresh();emit();
      const ok=st._ok;st._ok=st._bad=null;if(ok)ok(true)
    }
    else if(m.type==='tick'){
      st.out=m.output;st.tel=m.telemetry;refresh();
      const q=waits.get(m.id);
      if(q){
        waits.delete(m.id);
        clearTimeout(q.timer);
        q.resolve(m.output);
      }
    }
    else if(m.type==='error'){
      const e=Error(m.message||'Fly worker error');
      const q=waits.get(m.id);
      if(q){
        waits.delete(m.id);
        clearTimeout(q.timer);
        q.reject(e);
      } else failWorker(e)
    }
  };
  w.onerror=e=>{
    const dead=w;w=null;try{dead?.terminate()}catch{}
    failWorker(Error(e?.message||'Fly worker failed'));
  };
  return w
}
function ready(cb){
  ui();
  if(st.ready)return Promise.resolve(true);
  if(loading)return loading;
  st.loading=true;st.error=null;st.progress='starting fly worker';
  let h=null;
  if(cb){
    h=e=>cb(e.detail.progress||e.detail.backend);
    addEventListener('flymario-status',h)
  }
  loading=new Promise((ok,bad)=>{
    st._ok=v=>{if(h)removeEventListener('flymario-status',h);ok(v)};
    st._bad=e=>{if(h)removeEventListener('flymario-status',h);bad(e)};
    try{worker().postMessage({type:'load',base:BASE})}catch(err){failWorker(err)}
  });
  emit();
  return loading.finally(()=>{loading=null})
}
function context(x={}){st.ctx={...st.ctx,...x};w?.postMessage({type:'context',context:st.ctx});sync();refresh();return{...st.ctx}}
function tick(obs={}){
  if(!st.ready)return Promise.reject(Error('MaleCNS not loaded'));
  const id=++seq,payload={...obs,context:{...st.ctx,...(obs.context||{})}};
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      const q=waits.get(id);
      if(!q)return;
      waits.delete(id);
      reject(Error('Fly brain tick timed out'));
    },1800);
    waits.set(id,{resolve,reject,timer});
    try{worker().postMessage({type:'tick',id,obs:payload,steps:3})}
    catch(err){
      waits.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  })
}
function reset(){w?.postMessage({type:'reset'})}
function bearing(auto=0){if(st.ctx.targetMode==='left')return-.85;if(st.ctx.targetMode==='right')return.85;if(st.ctx.targetMode==='center')return 0;return S(auto)}
function ui(){if(panel)return panel;panel=document.createElement('div');panel.id='fly-mario-panel';panel.style.cssText='position:fixed;right:12px;bottom:86px;z-index:9997;width:310px;max-height:58vh;overflow:auto;background:#0d1216f2;border:1px solid #4f8b52;border-radius:12px;padding:10px 12px;color:#dff5df;font:12px/1.35 system-ui;box-shadow:0 8px 28px #0008;display:none';panel.innerHTML=`<div style="display:flex"><b>🪰 Fly Mario / MaleCNS</b><span id="fm-led" style="margin-left:auto">○</span></div><div id="fm-status" style="margin:6px 0;color:#a9d8aa">offline</div><div style="display:grid;grid-template-columns:65px 1fr;gap:5px"><label>Strain</label><select id="fm-strain"><option>explore</option><option>goomba</option><option>bowser</option><option>whomp</option><option>bully</option><option>mr_i</option><option>eyerok</option><option>friendly</option></select><label>Phase</label><select id="fm-phase"><option>base</option><option>tail</option><option>held</option><option>bomb</option><option>danger</option><option>vulnerable</option><option>weakpoint</option></select><label>Target</label><select id="fm-target"><option value="auto">auto/open path</option><option value="left">force left</option><option value="center">force center</option><option value="right">force right</option></select><label>Assist</label><div><input id="fm-assist" type="range" min="0" max="1" step=".01" value=".68" style="width:145px"><span id="fm-av">.68</span></div></div><pre id="fm-tel" style="white-space:pre-wrap;color:#b9c8b9;border-top:1px solid #29482b;padding-top:7px">No spikes yet.</pre><small style="color:#7f9f80">Real 166,700-neuron MaleCNS. Assist is explicit; combat output is bootstrap/provisional until trained.</small>`;document.body.appendChild(panel);for(const[id,key]of[['#fm-strain','strain'],['#fm-phase','phase'],['#fm-target','targetMode']])panel.querySelector(id).onchange=e=>context({[key]:e.target.value});panel.querySelector('#fm-assist').oninput=e=>context({assist:+e.target.value});sync();return panel}
function sync(){if(!panel)return;panel.querySelector('#fm-strain').value=st.ctx.strain;panel.querySelector('#fm-phase').value=st.ctx.phase;panel.querySelector('#fm-target').value=st.ctx.targetMode;panel.querySelector('#fm-assist').value=st.ctx.assist;panel.querySelector('#fm-av').textContent=(+st.ctx.assist).toFixed(2)}
function status(x){ui().querySelector('#fm-status').textContent=x}
function refresh(){if(!panel)return;const led=panel.querySelector('#fm-led');led.textContent=st.ready?'●':st.loading?'◐':'○';led.style.color=st.ready?'#7cff82':st.error?'#ff6b6b':'#e6c95a';if(!st.tel)return;const t=st.tel,r=t.rates||{},o=st.out;panel.querySelector('#fm-tel').textContent=`${st.backend}\n${st.neurons.toLocaleString()} cells / ${st.connections.toLocaleString()} edges\n${t.elapsedMs.toFixed(1)}ms compute → ${t.simMs}ms fly-time\nfired ${t.fired.toLocaleString()}\nstrain ${t.strain}.${t.phase}\nDNa02 L ${(r.dnaL||0).toFixed(1)} R ${(r.dnaR||0).toFixed(1)} Hz\nDNg100 ${(((r.dngL||0)+(r.dngR||0))/2).toFixed(1)} Hz\nDNp01 ${(r.dnp||0).toFixed(1)} Hz  MDN ${(r.mdn||0).toFixed(1)} Hz\nMario fwd ${o.forward.toFixed(2)} steer ${o.steer.toFixed(2)} jump ${o.jump.toFixed(2)}\n${o.primitive}`}
function show(on=true){ui().style.display=on?'block':'none'}
window.FlyMarioSM64=Object.freeze({ensureReady:ready,tick,reset,setContext:context,getContext:()=>({...st.ctx}),snapshot:snap,showPanel:show,targetBearing:bearing,connectome:{source:'MaleCNS v1.0 via alextitonis/fly.ai',commit:COMMIT,base:BASE}})
})();