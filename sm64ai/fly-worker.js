/* MaleCNS browser worker. Format/parser adapted from alextitonis/fly.ai (MIT, Copyright 2026 alextitonis). */
'use strict';
let M,W,B,G,BASE;
let ctx={strain:'explore',phase:'base',assist:.68};
const DT=.02, C=(x,a=0,b=1)=>Math.max(a,Math.min(b,Number.isFinite(x)?x:0)), S=x=>C(x,-1,1);
const status=text=>postMessage({type:'progress',text}), sleep=ms=>new Promise(r=>setTimeout(r,ms));
function rng(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}}
async function joined(urls,label){
  const cs=[];let got=0,last=0;
  for(const u of urls){
    for(let n=1;;n++){
      const part=[];let partBytes=0;
      try{
        const r=await fetch(u,{cache:'force-cache'});
        if(!r.ok||!r.body)throw Error(`${u}: HTTP ${r.status}`);
        const rd=r.body.getReader();
        for(;;){
          const q=await rd.read();
          if(q.done)break;
          part.push(q.value);partBytes+=q.value.length;
          const seen=got+partBytes;
          if(seen-last>2e6){last=seen;status(`downloading ${label}: ${(seen/1e6).toFixed(0)} MB`)}
        }
        // Only commit bytes after the entire request succeeds. Failed attempts are
        // thrown away so a retry cannot duplicate a truncated gzip prefix.
        cs.push(...part);got+=partBytes;break;
      }catch(e){
        if(n===3)throw e;
        last=got;
        status(`retrying ${label}`);
        await sleep(500*n);
      }
    }
  }
  const blob=new Blob(cs),h=cs[0];
  if(!(h?.[0]===31&&h?.[1]===139))return blob.arrayBuffer();
  if(!self.DecompressionStream)throw Error('Browser lacks gzip DecompressionStream');
  status(`decompressing ${label}`);
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
}
function magic(v,s){let g='';for(let i=0;i<4;i++)g+=String.fromCharCode(v.getUint8(i));if(g!==s)throw Error(`bad ${s} file`)}
function meta(buf){const v=new DataView(buf);magic(v,'FLYM');const n=v.getUint32(8,true),l=v.getUint32(12,true),h=JSON.parse(new TextDecoder().decode(new Uint8Array(buf,16,l)));let a=16+l;const ti=new Uint16Array(buf.slice(a,a+2*n));a+=2*n;const ci=new Uint8Array(buf,a,n);a+=n;return{n,types:h.types,classes:h.superclasses,p:h.params,ti,ci,side:new Uint8Array(buf,a,n)}}
function weights(buf){const v=new DataView(buf);magic(v,'FLYW');const n=v.getUint32(8,true),nnz=v.getUint32(12,true),ln=v.getFloat32(16,true),b=new Uint8Array(buf);let a=20;const vi=()=>{let x=0,s=0,q;do{q=b[a++];x+=(q&127)*2**s;s+=7}while(q&128);return x};const cp=new Uint32Array(n+1);for(let j=0;j<n;j++)cp[j+1]=cp[j]+vi();const ri=new Uint32Array(nnz);for(let j=0;j<n;j++){let row=0;for(let e=cp[j],f=1;e<cp[j+1];e++,f=0){row=f?vi():row+vi();ri[e]=row}}const code=b.slice(a,a+nnz),lut=new Float32Array(256);for(let q=0;q<128;q++){const z=Math.exp(ln*(1-q/127));lut[q]=z;lut[q|128]=-z}return{n,nnz,cp,ri,code,lut}}
function cells(names,side){const w=new Set(names),th=M.types.map(x=>w.has(x)),ch=M.classes.map(x=>w.has(x)),sd=side==='L'?1:side==='R'?2:0,o=[];for(let i=0;i<M.n;i++)if((th[M.ti[i]]||ch[M.ci[i]])&&(!sd||M.side[i]===sd))o.push(i);return Int32Array.from(o)}
function pref(p){const h=M.types.map(x=>x.startsWith(p)),o=[];for(let i=0;i<M.n;i++)if(h[M.ti[i]])o.push(i);return Int32Array.from(o)}
function uni(...aa){const s=new Set;for(const a of aa)for(const x of a)s.add(x);return Int32Array.from(s)}
class Brain{constructor(w,p){this.w=w;this.p=p;this.v=new Float32Array(w.n);this.d=new Float32Array(w.n);this.cur=new Float32Array(w.n);this.f=new Int32Array(w.n);this.fc=0;this.r=rng(64);this.dec=Math.exp(-p.dt/p.tau);this.pn=p.noise_hz*p.dt;this.steps=0}stim(a,x){for(let i=0;i<a.length;i++)this.d[a[i]]+=x}step(){const{cp,ri,code,lut}=this.w,c=this.cur;c.fill(0);for(let k=0;k<this.fc;k++){const j=this.f[k];for(let e=cp[j];e<cp[j+1];e++)c[ri[e]]+=lut[code[e]]}let m=0;for(let i=0;i<this.v.length;i++){let x=this.dec*this.v[i]+this.p.gain*c[i]+this.p.tonic+this.d[i];if(this.r()<this.pn)x+=this.p.noise_amp;if(x>=1){this.f[m++]=i;x=0}this.v[i]=x;this.d[i]=0}this.fc=m;this.steps++}}
function mask(a){const m=new Uint8Array(M.n);for(const x of a)m[x]=1;return m}
function groups(){const R=(n,s)=>cells([n],s),g={lcL:R('LC10a','L'),lcR:R('LC10a','R'),loomL:uni(R('LC4','L'),R('LPLC2','L')),loomR:uni(R('LC4','R'),R('LPLC2','R')),smallL:R('LPLC1','L'),smallR:R('LPLC1','R'),touch:pref('SNta'),cva:cells(['ORN_DA1','Or67d']),good:cells(['ORN_DM1','ORN_DM2','ORN_VL2a']),bad:cells(['ORN_DA2','ORN_V']),social:cells(['ORN_VA1v','Or47b']),dngL:R('DNg100','L'),dngR:R('DNg100','R'),dnaL:R('DNa02','L'),dnaR:R('DNa02','R'),dnp:cells(['DNp01']),mdn:cells(['MDN']),atk:uni(cells(['DNg11']),cells(['pIP10']))};g.ro={};for(const k of['dngL','dngR','dnaL','dnaR','dnp','mdn','atk'])g.ro[k]={a:g[k],m:mask(g[k])};return g}
const drive=(a,x)=>{if(a?.length&&x)B.stim(a,x)};
function sense(o){const q={...ctx,...(o.context||{})},b=S(o.targetBearing||0),st=C(o.targetStrength??.45),ch=.15+.55*st;if(b<-.08)drive(G.lcL,ch);else if(b>.08)drive(G.lcR,ch);else{drive(G.lcL,ch*.55);drive(G.lcR,ch*.55)}const ll=C(o.loomLeft??o.loom??0),lr=C(o.loomRight??o.loom??0);drive(G.loomL,.75*ll);drive(G.loomR,.75*lr);if(o.projectileLeft)drive(G.smallL,.55*C(o.projectileLeft));if(o.projectileRight)drive(G.smallR,.55*C(o.projectileRight));if(o.grounded)drive(G.touch,.04);switch(q.strain){case'goomba':drive(G.cva,.28);drive(G.bad,.08);break;case'bowser':drive(G.cva,.72);drive(G.social,.28);drive(G.bad,q.phase==='danger'?.5:.12);if(q.phase==='held')drive(G.touch,.22);if(q.phase==='bomb')drive(G.good,.48);break;case'whomp':drive(G.bad,q.phase==='vulnerable'?.12:.48);if(q.phase==='vulnerable')drive(G.good,.42);break;case'bully':drive(G.cva,.52);drive(G.touch,.08);break;case'mr_i':drive(G.social,.35);break;case'eyerok':drive(G.cva,.35);drive(G.good,q.phase==='weakpoint'?.5:.12);break;case'friendly':drive(G.good,.22)}return{q,b,st,ll,lr}}
function counts(){const o={};for(const k in G.ro)o[k]=0;for(let i=0;i<B.fc;i++){const n=B.f[i];for(const k in G.ro)if(G.ro[k].m[n])o[k]++}return o}
function hz(sum,n){const o={},sec=n*DT;for(const k in G.ro)o[k]=sum[k]/Math.max(1,G.ro[k].a.length)/sec;return o}
async function base(){status('warming fly brain');const s={};for(const k in G.ro)s[k]=0;for(let n=0;n<16;n++){B.step();const c=counts();for(const k in s)s[k]+=c[k];if(n%4===0)await sleep(0)}return hz(s,16)}
function decode(r,z,o){const b=BASE||{},a=C(z.q.assist??.68),dng=(r.dngL+r.dngR-b.dngL-b.dngR)/2,sl=r.dnaL-b.dnaL,sr=r.dnaR-b.dnaR,dnp=r.dnp-b.dnp,mdn=r.mdn-b.mdn,atk=r.atk-b.atk,ff=C(.12+dng/8),fs=S((sr-sl)/7),fj=C(dnp/18),fa=C(atk/12);let forward=Math.max(ff*(1-a*.25),a*(.34+.55*z.st)),steer=S(fs*(1-a*.35)+z.b*a*.62),jump=Math.max(fj,o.airborne?0:Math.max(z.ll,z.lr)*a*.82),backward=Math.max(C(mdn/8),o.stuck?Math.max(.62,.5+a*.25):0),attack=Math.max(fa,!['explore','friendly'].includes(z.q.strain)?a*Math.max(0,z.st-.58)*1.4:0),primitive=jump>.58?'jump':'walk';if(o.stuck){forward=Math.min(forward,.12);primitive='recover';}if(attack>.48){const s=z.q.strain,p=z.q.phase;if(s==='bowser'&&p==='tail')primitive='grab';else if(s==='bowser'&&p==='held')primitive='spin';else if(s==='bowser'&&p==='bomb'&&Math.abs(z.b)<.22)primitive='throw';else if(s==='whomp'&&p==='vulnerable')primitive=o.airborne?'ground_pound':'jump';else if(s==='bully')primitive='push';else if(s==='mr_i')primitive='orbit';else primitive='attack'}return{forward,backward,steer,jump,attack,primitive,assist:a,raw:{flyForward:ff,flySteer:fs,flyJump:fj,flyAttack:fa}}}
async function load(base){status('reading fly brain manifest');const r=await fetch(base+'brain.json',{cache:'force-cache'});if(!r.ok)throw Error(`brain.json HTTP ${r.status}`);const info=await r.json(),[mb,wb]=await Promise.all([joined([base+'meta.bin'],'labels'),joined(info.parts.map(x=>base+x),'MaleCNS')]);status('decoding 25 million connections');M=meta(mb);W=weights(wb);G=groups();B=new Brain(W,M.p);BASE=await baseLine();postMessage({type:'ready',neurons:M.n,connections:W.nnz,baseline:BASE,groups:Object.fromEntries(Object.entries(G).filter(([,v])=>v?.length!=null).map(([k,v])=>[k,v.length]))})}
async function baseLine(){return base()}
async function tick(m){const o=m.obs||{},t=performance.now(),z=sense(o),sum={};for(const k in G.ro)sum[k]=0;const n=Math.max(1,Math.min(6,m.steps||3));for(let i=0;i<n;i++){if(i)sense(o);B.step();const c=counts();for(const k in sum)sum[k]+=c[k]}const r=hz(sum,n),out=decode(r,z,o);postMessage({type:'tick',id:m.id,output:out,telemetry:{rates:r,baseline:BASE,elapsedMs:performance.now()-t,simMs:n*20,fired:B.fc,step:B.steps,strain:z.q.strain,phase:z.q.phase,bearing:z.b,strength:z.st}})}
onmessage=async({data:m})=>{try{if(m.type==='load')await load(m.base);else if(m.type==='tick')await tick(m);else if(m.type==='context')ctx={...ctx,...m.context};else if(m.type==='reset'&&B){B.v.fill(0);B.fc=0;B.steps=0;BASE=await base()}}catch(e){postMessage({type:'error',id:m.id,message:e?.message||String(e)})}};