(() => {
  'use strict';
  const P = window.PHONEMES;
  const $ = id => document.getElementById(id);
  const state = {index:0,samples:new Map(),audioCtx:null,stream:null,recorder:null,chunks:[],meterRAF:0,currentSource:null,art:null,artUrl:null,doodleEraser:false,editor:null,editUndo:new Map()};
  const DB_NAME='mainvoice-mainpack-builder', STORE='data', DB_VERSION=1;
  const TESTS={
    hello:{name:'Hello world',riseSemitones:3,words:[['HH','AH','L','OW'],['W','ER','L','D']]},
    fox:{name:'The quick brown fox jumped over the lazy dog',riseSemitones:0,words:[['DH','AH'],['K','W','IH','K'],['B','R','AW','N'],['F','AA','K','S'],['JH','AH','M','P','T'],['OW','V','ER'],['DH','AH'],['L','EY','Z','IY'],['D','AO','G']]}
  };

  function setStatus(msg,kind='ok'){
    $('globalStatus').textContent=msg;
    $('statusDot').className='dot'+(kind==='busy'?' busy':kind==='bad'?' bad':'');
  }
  function getAudioCtx(){
    if(!state.audioCtx){const AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw new Error('Web Audio is not supported in this browser.');state.audioCtx=new AC();}
    if(state.audioCtx.state==='suspended') state.audioCtx.resume().catch(()=>{});
    return state.audioCtx;
  }
  function openDb(){return new Promise((res,rej)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE)};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
  async function dbPut(k,v){const db=await openDb();return new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(v,k);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)})}
  async function dbDel(k){const db=await openDb();return new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(k);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)})}
  async function dbAll(){const db=await openDb();return new Promise((res,rej)=>{const tx=db.transaction(STORE,'readonly'),out=[];const r=tx.objectStore(STORE).openCursor();r.onsuccess=()=>{const c=r.result;if(c){out.push([c.key,c.value]);c.continue()}else res(out)};r.onerror=()=>rej(r.error)})}
  async function dbClear(){const db=await openDb();return new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).clear();tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)})}

  function revokeArtUrl(){if(state.artUrl){URL.revokeObjectURL(state.artUrl);state.artUrl=null}}
  function artBlob(item=state.art){return item?.bytes?new Blob([item.bytes],{type:item.mime||'image/png'}):null}
  function renderCharacterArt(){
    const img=$('characterArtPreview'),empty=$('characterArtEmpty');if(!img||!empty)return;revokeArtUrl();
    if(!state.art?.bytes){img.classList.add('hidden');img.removeAttribute('src');empty.classList.remove('hidden');return}
    state.artUrl=URL.createObjectURL(artBlob());img.src=state.artUrl;img.classList.remove('hidden');empty.classList.add('hidden');
  }
  async function decodeImage(blob){
    if('createImageBitmap' in window){try{return await createImageBitmap(blob)}catch{}}
    return await new Promise((res,rej)=>{const u=URL.createObjectURL(blob),im=new Image();im.onload=()=>{URL.revokeObjectURL(u);res(im)};im.onerror=()=>{URL.revokeObjectURL(u);rej(new Error('I could not decode that image.'))};im.src=u});
  }
  async function normalizeCharacterArt(blob){
    const image=await decodeImage(blob),w=image.width||image.naturalWidth,h=image.height||image.naturalHeight;if(!w||!h)throw new Error('That image has no usable size.');
    const c=document.createElement('canvas');c.width=c.height=512;const x=c.getContext('2d');x.clearRect(0,0,512,512);x.imageSmoothingEnabled=true;x.imageSmoothingQuality='high';const scale=Math.min(512/w,512/h),dw=w*scale,dh=h*scale;x.drawImage(image,(512-dw)/2,(512-dh)/2,dw,dh);if(image.close)image.close();
    const out=await new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error('Could not encode character art.')),'image/png'));
    return {bytes:await out.arrayBuffer(),mime:'image/png',width:512,height:512,updated:Date.now()};
  }
  async function saveCharacterArt(item){state.art=item;try{await dbPut('art',item)}catch(e){console.warn(e)}renderCharacterArt();saveMeta()}
  async function handleCharacterArtUpload(file){if(!file)return;setStatus('processing character art','busy');try{await saveCharacterArt(await normalizeCharacterArt(file));setStatus('character art saved')}catch(e){setStatus('art failed','bad');alert(e.message)}finally{$('characterArtUpload').value=''}}
  async function clearCharacterArt(){state.art=null;revokeArtUrl();try{await dbDel('art')}catch{}renderCharacterArt();setStatus('character art removed')}
  function canvasPoint(e){const c=$('doodleCanvas'),r=c.getBoundingClientRect();return{x:(e.clientX-r.left)*c.width/r.width,y:(e.clientY-r.top)*c.height/r.height}}
  function setupDoodleCanvas(){
    const c=$('doodleCanvas'),x=c.getContext('2d');let drawing=false,last=null;
    const stroke=(a,b)=>{x.save();x.globalCompositeOperation=state.doodleEraser?'destination-out':'source-over';x.strokeStyle=$('doodleColor').value;x.lineWidth=+$('doodleSize').value;x.lineCap='round';x.lineJoin='round';x.beginPath();x.moveTo(a.x,a.y);x.lineTo(b.x,b.y);x.stroke();x.restore()};
    c.addEventListener('pointerdown',e=>{drawing=true;c.setPointerCapture?.(e.pointerId);last=canvasPoint(e);stroke(last,{x:last.x+.01,y:last.y+.01})});
    c.addEventListener('pointermove',e=>{if(!drawing)return;const p=canvasPoint(e);stroke(last,p);last=p});
    const end=()=>{drawing=false;last=null};c.addEventListener('pointerup',end);c.addEventListener('pointercancel',end);
  }
  async function openDoodle(){
    $('doodlePanel').classList.remove('hidden');const c=$('doodleCanvas'),x=c.getContext('2d');x.clearRect(0,0,c.width,c.height);
    if(state.art?.bytes){try{const im=await decodeImage(artBlob());x.drawImage(im,0,0,c.width,c.height);if(im.close)im.close()}catch{}}
    $('doodlePanel').scrollIntoView({behavior:'smooth',block:'nearest'});
  }
  function clearDoodle(){const c=$('doodleCanvas');c.getContext('2d').clearRect(0,0,c.width,c.height)}
  async function saveDoodle(){const c=$('doodleCanvas'),blob=await new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error('Could not save drawing.')),'image/png'));await saveCharacterArt({bytes:await blob.arrayBuffer(),mime:'image/png',width:512,height:512,updated:Date.now()});$('doodlePanel').classList.add('hidden');setStatus('drawing saved')}

  function encodeWav(samples,sampleRate){
    const ab=new ArrayBuffer(44+samples.length*2),dv=new DataView(ab);const put=(o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i))};
    put(0,'RIFF');dv.setUint32(4,36+samples.length*2,true);put(8,'WAVE');put(12,'fmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,1,true);dv.setUint32(24,sampleRate,true);dv.setUint32(28,sampleRate*2,true);dv.setUint16(32,2,true);dv.setUint16(34,16,true);put(36,'data');dv.setUint32(40,samples.length*2,true);
    let o=44;for(let i=0;i<samples.length;i++,o+=2){const s=Math.max(-1,Math.min(1,samples[i]));dv.setInt16(o,s<0?s*0x8000:s*0x7fff,true)}return ab;
  }
  async function cleanAudio(blob){
    const ctx=getAudioCtx(), raw=await blob.arrayBuffer();let decoded;
    try{decoded=await ctx.decodeAudioData(raw.slice(0))}catch{throw new Error('I could not decode that audio file in this browser.')}
    const mono=new Float32Array(decoded.length);for(let c=0;c<decoded.numberOfChannels;c++){const d=decoded.getChannelData(c);for(let i=0;i<mono.length;i++)mono[i]+=d[i]/decoded.numberOfChannels}
    let peak=0;for(const x of mono)peak=Math.max(peak,Math.abs(x));if(peak<0.003)throw new Error('That recording is basically silent. Try again a little closer to the mic.');
    const threshold=Math.max(.005,peak*.045);let a=0,b=mono.length;while(a<b&&Math.abs(mono[a])<threshold)a++;while(b>a&&Math.abs(mono[b-1])<threshold)b--;
    const pad=Math.floor(decoded.sampleRate*.018);a=Math.max(0,a-pad);b=Math.min(mono.length,b+pad);if(b-a<decoded.sampleRate*.02){a=0;b=mono.length}
    let clip=mono.slice(a,b);const maxLen=Math.floor(decoded.sampleRate*1.35);if(clip.length>maxLen)clip=clip.slice(0,maxLen);
    let p=0;for(const x of clip)p=Math.max(p,Math.abs(x));const gain=p?Math.min(3,.9/p):1;for(let i=0;i<clip.length;i++)clip[i]*=gain;
    const fade=Math.min(Math.floor(decoded.sampleRate*.006),Math.floor(clip.length/2));for(let i=0;i<fade;i++){const g=i/Math.max(1,fade);clip[i]*=g;clip[clip.length-1-i]*=g}
    return {wav:encodeWav(clip,decoded.sampleRate),duration:clip.length/decoded.sampleRate,sampleRate:decoded.sampleRate,updated:Date.now()};
  }
  async function saveSample(code,item){state.samples.set(code,item);try{await dbPut('sample:'+code,item)}catch(e){console.warn(e)}refreshAll()}
  async function decodeSample(item){return getAudioCtx().decodeAudioData(item.wav.slice(0))}
  async function playSample(item){if(state.currentSource){try{state.currentSource.stop()}catch{}}const ctx=getAudioCtx(),buf=await decodeSample(item),s=ctx.createBufferSource();s.buffer=buf;s.connect(ctx.destination);s.start();state.currentSource=s;s.onended=()=>{if(state.currentSource===s)state.currentSource=null}}

  const EDITOR_SHORT=new Set(['P','T','K','B','D','G','CH','JH']);
  const EDITOR_GLIDE=new Set(['R','W','Y','L']);
  const EDITOR_FRICATIVE=new Set(['F','TH','S','SH','HH','V','DH','Z','ZH']);
  const EDITOR_NASAL=new Set(['M','N','NG']);
  function editorRecommendedText(code){
    if(EDITOR_SHORT.has(code))return 'Suggested finished length: roughly 50–160 ms. Keep the burst; chop off any “uh” or click.';
    if(EDITOR_GLIDE.has(code))return 'Suggested finished length: roughly 120–300 ms. These voiced transitions usually work better short.';
    if(EDITOR_FRICATIVE.has(code))return 'Suggested finished length: roughly 250–800 ms. Keep enough steady friction for the synth to borrow from.';
    if(EDITOR_NASAL.has(code))return 'Suggested finished length: roughly 300–800 ms. A steady held nasal is useful.';
    return 'Suggested finished length: roughly 300–900 ms. Keep the clean, steady vowel/glide rather than dead air.';
  }
  function audioBufferToMono(buf){const mono=new Float32Array(buf.length);for(let c=0;c<buf.numberOfChannels;c++){const d=buf.getChannelData(c);for(let i=0;i<mono.length;i++)mono[i]+=d[i]/buf.numberOfChannels}return mono}
  function cloneSampleItem(item){return {wav:item.wav.slice(0),duration:item.duration,sampleRate:item.sampleRate,updated:item.updated,edited:item.edited}}
  function editorMs(sec){return Math.round(sec*1000)}
  function editorClampSelection(){
    const e=state.editor;if(!e)return;const min=.006;e.start=Math.max(0,Math.min(e.start,e.duration-min));e.end=Math.min(e.duration,Math.max(e.end,e.start+min));
  }
  function drawWaveEditor(){
    const e=state.editor,c=$('waveEditorCanvas');if(!e||!c)return;const x=c.getContext('2d'),w=c.width,h=c.height,mid=h/2;x.clearRect(0,0,w,h);x.fillStyle='#0d1116';x.fillRect(0,0,w,h);x.strokeStyle='#27313b';x.lineWidth=1;x.beginPath();x.moveTo(0,mid+.5);x.lineTo(w,mid+.5);x.stroke();
    const mono=e.mono,per=Math.max(1,mono.length/w);x.strokeStyle='#93a2b3';x.lineWidth=1;x.beginPath();for(let px=0;px<w;px++){const a=Math.floor(px*per),b=Math.min(mono.length,Math.floor((px+1)*per));let lo=1,hi=-1;for(let i=a;i<b;i++){const v=mono[i];if(v<lo)lo=v;if(v>hi)hi=v}if(b<=a){lo=hi=mono[Math.min(a,mono.length-1)]||0}x.moveTo(px,mid-hi*(h*.42));x.lineTo(px,mid-lo*(h*.42))}x.stroke();
    const sx=e.start/e.duration*w,ex=e.end/e.duration*w;x.fillStyle='rgba(0,0,0,.55)';x.fillRect(0,0,sx,h);x.fillRect(ex,0,w-ex,h);x.fillStyle='rgba(224,137,63,.10)';x.fillRect(sx,0,Math.max(1,ex-sx),h);x.strokeStyle='#e0893f';x.lineWidth=4;x.beginPath();x.moveTo(sx,0);x.lineTo(sx,h);x.moveTo(ex,0);x.lineTo(ex,h);x.stroke();
    for(const hx of [sx,ex]){x.fillStyle='#e0893f';x.fillRect(hx-7,8,14,26);x.fillRect(hx-7,h-34,14,26)}
    if(e.repairCursor!=null){const rx=e.repairCursor/e.duration*w;x.strokeStyle='#bd78e6';x.lineWidth=2;x.beginPath();x.moveTo(rx,0);x.lineTo(rx,h);x.stroke();x.fillStyle='#bd78e6';x.beginPath();x.arc(rx,14,6,0,Math.PI*2);x.fill()}
  }
  function updateEditorUi(){
    const e=state.editor;if(!e)return;editorClampSelection();const durMs=Math.max(1,editorMs(e.duration));$('editorStart').max=Math.max(1,durMs-1);$('editorEnd').max=durMs;$('editorStart').value=Math.min(durMs-1,editorMs(e.start));$('editorEnd').value=Math.max(1,editorMs(e.end));$('editorStartVal').textContent=editorMs(e.start)+' ms';$('editorEndVal').textContent=editorMs(e.end)+' ms';$('editorTotalTime').textContent=durMs+' ms';$('editorSelectionInfo').textContent=`keeping ${editorMs(e.end-e.start)} ms`;$('editorCode').textContent=e.code;$('editorRecommendation').textContent=editorRecommendedText(e.code);$('healClickBtn').disabled=e.repairCursor==null;$('undoAudioEditBtn').disabled=!state.editUndo.has(e.code);drawWaveEditor();
  }
  async function openAudioEditor(){
    const code=P[state.index].c,item=state.samples.get(code);if(!item)return;setStatus('opening waveform editor','busy');try{const buf=await decodeSample(item),mono=audioBufferToMono(buf);state.editor={code,mono,sampleRate:buf.sampleRate,duration:buf.duration,start:0,end:buf.duration,repairCursor:null,dragHandle:null};$('editorFadeIn').value=6;$('editorFadeOut').value=6;$('editorFadeInVal').textContent='6 ms';$('editorFadeOutVal').textContent='6 ms';$('audioEditorPanel').classList.remove('hidden');$('editorStatus').className='notice';$('editorStatus').innerHTML='<b>Non-destructive until you press Save.</b> Preview as much as you want first.';updateEditorUi();$('audioEditorPanel').scrollIntoView({behavior:'smooth',block:'nearest'});setStatus('waveform editor ready')}catch(err){setStatus('editor failed','bad');alert(err.message)}
  }
  function closeAudioEditor(){state.editor=null;$('audioEditorPanel')?.classList.add('hidden')}
  function makeEditedMono(e,{applySelection=true}={}){
    let a=applySelection?Math.max(0,Math.floor(e.start*e.sampleRate)):0,b=applySelection?Math.min(e.mono.length,Math.ceil(e.end*e.sampleRate)):e.mono.length;
    if($('editorSnapZero')?.checked&&applySelection){const radius=Math.max(1,Math.round(e.sampleRate*.006));a=snapToZero(e.mono,a,radius);b=snapToZero(e.mono,b,radius);if(b<=a+8){a=Math.max(0,Math.floor(e.start*e.sampleRate));b=Math.min(e.mono.length,Math.ceil(e.end*e.sampleRate))}}
    const out=e.mono.slice(a,b),fi=Math.min(out.length>>1,Math.round(e.sampleRate*(+$('editorFadeIn').value/1000))),fo=Math.min(out.length>>1,Math.round(e.sampleRate*(+$('editorFadeOut').value/1000)));
    for(let i=0;i<fi;i++)out[i]*=i/Math.max(1,fi);for(let i=0;i<fo;i++)out[out.length-1-i]*=i/Math.max(1,fo);return out
  }
  function snapToZero(mono,index,radius){let best=Math.max(0,Math.min(mono.length-1,index)),score=Math.abs(mono[best]||0),lo=Math.max(0,best-radius),hi=Math.min(mono.length-1,best+radius);for(let i=lo;i<=hi;i++){const s=Math.abs(mono[i]);if(s<score){score=s;best=i}}return best}
  async function playEditorMono(mono,sr){if(state.currentSource){try{state.currentSource.stop()}catch{}}const ctx=getAudioCtx(),buf=ctx.createBuffer(1,mono.length,sr);buf.copyToChannel(mono,0);const src=ctx.createBufferSource();src.buffer=buf;src.connect(ctx.destination);src.start();state.currentSource=src;src.onended=()=>{if(state.currentSource===src)state.currentSource=null}}
  async function previewAudioEdit(){const e=state.editor;if(!e)return;const mono=makeEditedMono(e);await playEditorMono(mono,e.sampleRate);$('editorStatus').className='notice good';$('editorStatus').innerHTML=`<b>Previewing ${editorMs(mono.length/e.sampleRate)} ms.</b> Nothing has been saved yet.`}
  async function saveAudioEdit(){
    const e=state.editor;if(!e)return;const current=state.samples.get(e.code);if(!current)return;const mono=makeEditedMono(e);if(mono.length<Math.round(e.sampleRate*.015))return alert('That edit is too short to be useful. Leave at least about 15 ms.');state.editUndo.set(e.code,cloneSampleItem(current));const item={wav:encodeWav(mono,e.sampleRate),duration:mono.length/e.sampleRate,sampleRate:e.sampleRate,updated:Date.now(),edited:true};await saveSample(e.code,item);await openAudioEditor();$('editorStatus').className='notice good';$('editorStatus').innerHTML=`<b>Saved.</b> ${e.code} is now ${editorMs(item.duration)} ms. The previous version can still be restored with Undo until this page is refreshed.`;setStatus('edited sample saved')
  }
  async function undoAudioEdit(){const e=state.editor;if(!e)return;const old=state.editUndo.get(e.code);if(!old)return;state.editUndo.delete(e.code);await saveSample(e.code,old);await openAudioEditor();$('editorStatus').className='notice good';$('editorStatus').innerHTML='<b>Undo complete.</b> Restored the sample from before your last saved waveform edit.';setStatus('audio edit undone')}
  function resetAudioEdit(){const e=state.editor;if(!e)return;e.start=0;e.end=e.duration;e.repairCursor=null;updateEditorUi();$('editorStatus').className='notice';$('editorStatus').innerHTML='<b>Handles reset.</b> The working waveform itself was not changed.'}
  function healEditorClick(){
    const e=state.editor;if(!e||e.repairCursor==null)return;const widthMs=+$('editorRepairWidth').value,width=Math.max(2,Math.round(e.sampleRate*widthMs/1000)),center=Math.round(e.repairCursor*e.sampleRate),a=Math.max(0,center-Math.floor(width/2)),b=Math.min(e.mono.length,center+Math.ceil(width/2));if(a<=1||b>=e.mono.length-1)return alert('That repair cursor is too close to an edge. Use the orange trim handle for edge clicks instead.');
    const overlap=Math.min(Math.round(e.sampleRate*.003),a,e.mono.length-b),newLen=e.mono.length-(b-a)-overlap,out=new Float32Array(Math.max(1,newLen));let pos=0;const plainEnd=a-overlap;out.set(e.mono.subarray(0,plainEnd),0);pos=plainEnd;for(let i=0;i<overlap;i++){const q=(i+1)/(overlap+1);out[pos++]=e.mono[a-overlap+i]*(1-q)+e.mono[b+i]*q}out.set(e.mono.subarray(b+overlap),pos);e.mono=out;e.duration=out.length/e.sampleRate;e.start=0;e.end=e.duration;e.repairCursor=null;updateEditorUi();$('editorStatus').className='notice good';$('editorStatus').innerHTML=`<b>Working copy repaired.</b> Removed about ${widthMs} ms around the cursor and crossfaded the gap. Preview it before saving.`
  }
  function setupWaveEditorCanvas(){
    const c=$('waveEditorCanvas');let dragging=null;const timeAt=e=>{const r=c.getBoundingClientRect(),x=Math.max(0,Math.min(r.width,e.clientX-r.left));return state.editor?x/r.width*state.editor.duration:0};
    c.addEventListener('pointerdown',ev=>{const e=state.editor;if(!e)return;const r=c.getBoundingClientRect(),px=Math.max(0,Math.min(r.width,ev.clientX-r.left)),sx=e.start/e.duration*r.width,ex=e.end/e.duration*r.width,ds=Math.abs(px-sx),de=Math.abs(px-ex);if(Math.min(ds,de)>26)return;const t=timeAt(ev);dragging=ds<=de?'start':'end';c.setPointerCapture?.(ev.pointerId);if(dragging==='start')e.start=Math.min(t,e.end-.006);else e.end=Math.max(t,e.start+.006);updateEditorUi()});
    c.addEventListener('pointermove',ev=>{const e=state.editor;if(!e||!dragging)return;const t=timeAt(ev);if(dragging==='start')e.start=Math.min(Math.max(0,t),e.end-.006);else e.end=Math.max(Math.min(e.duration,t),e.start+.006);updateEditorUi()});
    const end=()=>{dragging=null};c.addEventListener('pointerup',end);c.addEventListener('pointercancel',end);
    c.addEventListener('dblclick',ev=>{if(!state.editor)return;state.editor.repairCursor=timeAt(ev);updateEditorUi();$('editorStatus').className='notice';$('editorStatus').innerHTML='<b>Repair cursor placed.</b> If that purple line is on the click/spike, press Heal click at cursor.'});
  }

  function progress(){return P.reduce((n,p)=>n+(state.samples.has(p.c)?1:0),0)}
  function refreshProgress(){const n=progress(),pct=n/P.length*100,deg=pct*3.6;$('progressNumber').textContent=`${n}/${P.length}`;$('progressBar').style.width=pct+'%';$('progressRing').style.background=`conic-gradient(var(--accent) ${deg}deg,#252b33 ${deg}deg)`;$('progressText').textContent=n===P.length?'All 39 are recorded. Check any weird takes, then export your pack.':`${P.length-n} sound${P.length-n===1?'':'s'} left.`;refreshExportStatus()}
  function refreshGuide(){const p=P[state.index],item=state.samples.get(p.c);if(state.editor&&state.editor.code!==p.c)closeAudioEditor();$('phonemeIndex').textContent=`${state.index+1} / ${P.length}`;$('guideCode').textContent=p.c;$('guideWord').textContent=p.w;$('guideInstruction').innerHTML=`Target: <b>${p.sound}</b>. ${p.say}`;$('guideNote').textContent=p.tip;$('guideState').textContent=item?'RECORDED':'MISSING';$('guideState').className='state-badge '+(item?'recorded':'missing');$('takeArea').classList.toggle('hidden',!item);$('waveInfo').textContent=item?`saved · ${item.duration.toFixed(2)} s · ${(item.sampleRate/1000).toFixed(1)} kHz WAV`:'sample ready';$('prevBtn').disabled=state.index===0;$('nextBtn').textContent=state.index===P.length-1?'Finish ✓':'Next →'}
  function refreshBank(){const q=$('bankSearch').value.trim().toLowerCase(),f=$('bankFilter').value,r=$('bankGrid');r.innerHTML='';P.forEach((p,i)=>{const rec=state.samples.has(p.c);if(q&&!(`${p.c} ${p.w} ${p.sound}`.toLowerCase().includes(q)))return;if(f==='recorded'&&!rec||f==='missing'&&rec||f==='vowel'&&p.type!=='vowel'||f==='consonant'&&p.type!=='consonant')return;const b=document.createElement('button');b.className='phoneme-tile '+(rec?'recorded':'missing');b.innerHTML=`<span class="code">${p.c}</span><span class="word">${p.w}</span>`;b.onclick=async e=>{if(e.altKey&&rec){await playSample(state.samples.get(p.c));return}state.index=i;switchTab('guide');refreshGuide()};b.title=rec?'Click to edit. Alt+click to audition.':'Click to record.';r.appendChild(b)})}
  function refreshAll(){refreshProgress();refreshGuide();refreshBank();refreshTestStatus();renderTestPhonemeButtons()}
  function switchTab(name){document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='tab-'+name))}

  function hearExample(){const p=P[state.index];if(!('speechSynthesis'in window))return alert('Your browser does not expose speechSynthesis.');speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(p.w);u.rate=.72;u.pitch=1;speechSynthesis.speak(u)}
  async function startRecording(){
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone recording needs localhost/HTTPS and a modern browser. Use start.bat or run python server.py.');
      state.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});state.chunks=[];const recordCode=P[state.index].c;
      const types=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/webm'];const mime=types.find(t=>MediaRecorder.isTypeSupported(t))||'';state.recorder=new MediaRecorder(state.stream,mime?{mimeType:mime}:undefined);
      state.recorder.ondataavailable=e=>{if(e.data.size)state.chunks.push(e.data)};state.recorder.onstop=async()=>{stopMeter();const blob=new Blob(state.chunks,{type:state.recorder.mimeType||'audio/webm'});state.stream?.getTracks().forEach(t=>t.stop());state.stream=null;$('recordBtn').disabled=false;$('stopRecordBtn').disabled=true;setStatus('processing take','busy');try{await saveSample(recordCode,await cleanAudio(blob));setStatus('take saved')}catch(e){setStatus('take failed','bad');alert(e.message)}};
      state.recorder.start(100);$('recordBtn').disabled=true;$('stopRecordBtn').disabled=false;setStatus('recording','busy');startMeter(state.stream);
    }catch(e){setStatus('microphone unavailable','bad');alert(e.message)}
  }
  function stopRecording(){if(state.recorder&&state.recorder.state!=='inactive')state.recorder.stop()}
  function startMeter(stream){const ctx=getAudioCtx(),src=ctx.createMediaStreamSource(stream),an=ctx.createAnalyser();an.fftSize=512;src.connect(an);const d=new Uint8Array(an.fftSize);const loop=()=>{an.getByteTimeDomainData(d);let sum=0;for(const x of d){const v=(x-128)/128;sum+=v*v}const rms=Math.sqrt(sum/d.length);$('meter').firstElementChild.style.width=Math.min(100,rms*420)+'%';state.meterRAF=requestAnimationFrame(loop)};loop()}
  function stopMeter(){cancelAnimationFrame(state.meterRAF);$('meter').firstElementChild.style.width='0%'}
  async function handleUpload(file){if(!file)return;closeAudioEditor();setStatus('processing upload','busy');try{await saveSample(P[state.index].c,await cleanAudio(file));setStatus('sample saved')}catch(e){setStatus('upload failed','bad');alert(e.message)}finally{$('sampleUpload').value=''}}

  function testCodes(test){return test.words.flat()}
  function testMissing(test){return [...new Set(testCodes(test).filter(c=>!state.samples.has(c)))]}
  function refreshTestStatus(){
    if(!$('helloTestStatus'))return;
    for(const [key,test] of Object.entries(TESTS)){
      const missing=testMissing(test),box=$(key==='hello'?'helloTestStatus':'foxTestStatus'),btn=$(key==='hello'?'testHelloBtn':'testFoxBtn'),cbtn=$(key==='hello'?'continuousHelloBtn':'continuousFoxBtn');
      btn.disabled=missing.length>0;if(cbtn)cbtn.disabled=missing.length>0;
      if(missing.length){box.className='notice';box.innerHTML=`<b>Needs ${missing.length} more sound${missing.length===1?'':'s'}:</b> ${missing.join(', ')}. You can still keep recording and come back.`}
      else{box.className='notice good';box.innerHTML='<b>Ready.</b> Every phoneme needed for this test has a saved take.'}
    }
    const cb=$('continuousTestStatus');if(cb){const h=testMissing(TESTS.hello).length,f=testMissing(TESTS.fox).length;if(!h&&!f){cb.className='notice good';cb.innerHTML='<b>Ready.</b> Both continuous speech tests can be rendered with the overlap slider below.'}else if(!h||!f){cb.className='notice good';cb.innerHTML='<b>Partly ready.</b> At least one continuous sentence can be tested now.'}else{cb.className='notice';cb.textContent='Complete the phonemes needed by a sentence, then run it here.'}}
  }
  function renderTestPhonemeButtons(){
    const r=$('testPhonemeButtons');if(!r)return;r.innerHTML='';const used=new Set([...testCodes(TESTS.hello),...testCodes(TESTS.fox)]);
    P.forEach((p,i)=>{if(!used.has(p.c))return;const rec=state.samples.has(p.c),b=document.createElement('button');b.disabled=false;b.className=rec?'recorded':'missing';b.innerHTML=`<b>${p.c}</b><span>${p.w}</span>`;b.title=rec?'Click to edit. Alt+click to hear the raw take.':'Click to record this missing sound.';b.onclick=async e=>{if(e.altKey&&rec){await playSample(state.samples.get(p.c));return}state.index=i;switchTab('guide');refreshGuide();window.scrollTo({top:0,behavior:'smooth'})};r.appendChild(b)})
  }
  const CONTINUOUS_SHORT = new Set(['P','T','K','B','D','G','CH','JH']);
  const CONTINUOUS_GLIDE = new Set(['R','W','Y','L']);
  const CONTINUOUS_FRICATIVE = new Set(['F','TH','S','SH','HH','V','DH','Z','ZH']);
  const CONTINUOUS_NASAL = new Set(['M','N','NG']);
  const CONTINUOUS_DIPHTHONG = new Set(['AY','AW','EY','OW','OY']);
  function continuousMaxSourceSeconds(code){
    if(CONTINUOUS_SHORT.has(code))return .115;
    if(CONTINUOUS_GLIDE.has(code))return .16;
    if(CONTINUOUS_FRICATIVE.has(code))return .145;
    if(CONTINUOUS_NASAL.has(code))return .17;
    if(CONTINUOUS_DIPHTHONG.has(code))return .205;
    return .18; // ordinary vowels
  }

  async function renderContinuousTest(test){
    const missing=testMissing(test);if(missing.length)throw new Error('Record these phonemes first: '+missing.join(', '));
    const settings=packDefaults(),codes=testCodes(test),unique=[...new Set(codes)],buffers=new Map();
    await Promise.all(unique.map(async c=>buffers.set(c,await decodeSample(state.samples.get(c)))));
    const overlap=Math.max(0,+$('continuousOverlap').value)/1000,wordGap=settings.wordGapMs/1000,events=[];let t=.04,phoneIndex=0;const totalPhones=codes.length;
    test.words.forEach((word,wi)=>{
      word.forEach(code=>{
        const buf=buffers.get(code),rise=test.riseSemitones*(totalPhones<=1?0:phoneIndex/(totalPhones-1)),pitch=settings.pitchSemitones+rise;
        const sourceDur=Math.min(buf.duration,continuousMaxSourceSeconds(code));
        const outDur=sourceDur/Math.max(.05,settings.speed),ov=Math.min(overlap,outDur*.60);
        events.push({buffer:buf,when:t,outDur,sourceDur,pitch,ov});
        t+=Math.max(.018,outDur-ov);phoneIndex++;
      });
      if(wi<test.words.length-1)t+=Math.min(.11,wordGap);
    });
    const sr=48000,total=t+.08,off=new OfflineAudioContext(1,Math.max(1,Math.ceil(total*sr)),sr),master=off.createGain();master.gain.value=.90;master.connect(off.destination);
    for(const ev of events){
      const src=off.createBufferSource(),g=off.createGain();src.buffer=MainVoiceDSP.toAudioBuffer(off,ev.buffer,{pitchSemitones:ev.pitch,speed:settings.speed,maxSourceSeconds:ev.sourceDur});src.connect(g);g.connect(master);
      const actualDur=src.buffer.duration,cross=Math.min(Math.max(.004,ev.ov*.55),.024,actualDur*.28);
      g.gain.setValueAtTime(0,ev.when);g.gain.linearRampToValueAtTime(1,ev.when+cross);g.gain.setValueAtTime(1,Math.max(ev.when+cross,ev.when+actualDur-cross));g.gain.linearRampToValueAtTime(0,ev.when+actualDur);
      src.start(ev.when);
    }
    return off.startRendering();
  }

  async function speakContinuousTest(key){
    const test=TESTS[key],box=$('continuousTestStatus');stopTestPlayback();setStatus('rendering continuous speech','busy');
    try{
      const buf=await renderContinuousTest(test),ctx=getAudioCtx(),src=ctx.createBufferSource();src.buffer=buf;src.connect(ctx.destination);src.start();state.currentSource=src;
      src.onended=()=>{if(state.currentSource===src){state.currentSource=null;setStatus('continuous test finished')}};
      box.className='notice good';box.innerHTML=`<b>Playing ${test.name} continuously.</b> Overlap: ${Math.round(+$('continuousOverlap').value)} ms. Drag the slider and replay until transitions sound natural.`;setStatus('playing continuous speech','busy');
    }catch(e){box.className='notice bad';box.textContent=e.message;setStatus('continuous test failed','bad')}
  }

  async function renderTest(test){
    const missing=testMissing(test);if(missing.length)throw new Error('Record these phonemes first: '+missing.join(', '));
    const settings=packDefaults(),codes=testCodes(test),unique=[...new Set(codes)],buffers=new Map();
    await Promise.all(unique.map(async c=>buffers.set(c,await decodeSample(state.samples.get(c)))));
    const overlap=settings.overlapMs/1000,wordGap=settings.wordGapMs/1000,events=[];let t=.05,phoneIndex=0;const totalPhones=codes.length;
    test.words.forEach((word,wi)=>{word.forEach(code=>{const buf=buffers.get(code),rise=test.riseSemitones*(totalPhones<=1?0:phoneIndex/(totalPhones-1)),pitch=settings.pitchSemitones+rise,dur=buf.duration/Math.max(.05,settings.speed);events.push({buffer:buf,when:t,dur,pitch});t+=Math.max(.012,dur-overlap);phoneIndex++});if(wi<test.words.length-1)t+=wordGap});
    const sr=48000,total=t+.08,off=new OfflineAudioContext(1,Math.max(1,Math.ceil(total*sr)),sr),master=off.createGain();master.gain.value=.92;master.connect(off.destination);
    for(const ev of events){const src=off.createBufferSource(),g=off.createGain();src.buffer=MainVoiceDSP.toAudioBuffer(off,ev.buffer,{pitchSemitones:ev.pitch,speed:settings.speed});src.connect(g);g.connect(master);const dur=src.buffer.duration,fade=Math.min(.012,dur*.22);g.gain.setValueAtTime(0,ev.when);g.gain.linearRampToValueAtTime(1,ev.when+fade);g.gain.setValueAtTime(1,Math.max(ev.when+fade,ev.when+dur-fade));g.gain.linearRampToValueAtTime(0,ev.when+dur);src.start(ev.when)}
    return off.startRendering();
  }
  function stopTestPlayback(){if(state.currentSource){try{state.currentSource.stop()}catch{}state.currentSource=null}setStatus('ready')}
  async function speakTest(key){
    const test=TESTS[key],statusBox=$(key==='hello'?'helloTestStatus':'foxTestStatus');stopTestPlayback();setStatus('rendering test','busy');
    try{const buf=await renderTest(test),ctx=getAudioCtx(),src=ctx.createBufferSource();src.buffer=buf;src.connect(ctx.destination);src.start();state.currentSource=src;src.onended=()=>{if(state.currentSource===src){state.currentSource=null;setStatus('test finished')}};statusBox.className='notice good';statusBox.innerHTML=`<b>Playing ${test.name}.</b> ${key==='hello'?'Pitch rises gently across the phrase.':'Listen for clipped, weak, or wrong phonemes.'}`;setStatus('playing test','busy')}
    catch(e){setStatus('test failed','bad');statusBox.className='notice bad';statusBox.textContent=e.message}
  }

  function readU16(dv,o){return dv.getUint16(o,true)}function readU32(dv,o){return dv.getUint32(o,true)}
  async function inflateZipData(bytes,method){
    if(method===0)return bytes.slice();
    if(method===8){if(!('DecompressionStream'in window))throw new Error('This ZIP uses compression that this browser cannot unpack. Import the original MainVoice ZIP exported by this builder.');let ds;try{ds=new DecompressionStream('deflate-raw')}catch{throw new Error('This ZIP is deflated, but this browser cannot decode raw ZIP deflate. Import the original MainVoice ZIP exported by this builder.')}const stream=new Blob([bytes]).stream().pipeThrough(ds);return new Uint8Array(await new Response(stream).arrayBuffer())}
    throw new Error('Unsupported ZIP compression method '+method+'.')
  }
  async function readZipEntries(file){
    const ab=await file.arrayBuffer(),dv=new DataView(ab),bytes=new Uint8Array(ab),min=Math.max(0,bytes.length-65557);let eocd=-1;
    for(let i=bytes.length-22;i>=min;i--){if(readU32(dv,i)===0x06054b50){eocd=i;break}}
    if(eocd<0)throw new Error('That does not look like a normal ZIP file.');const count=readU16(dv,eocd+10),cdOffset=readU32(dv,eocd+16),dec=new TextDecoder(),entries=new Map();let pos=cdOffset;
    for(let n=0;n<count;n++){
      if(readU32(dv,pos)!==0x02014b50)throw new Error('The ZIP directory is damaged or unsupported.');const method=readU16(dv,pos+10),compSize=readU32(dv,pos+20),nameLen=readU16(dv,pos+28),extraLen=readU16(dv,pos+30),commentLen=readU16(dv,pos+32),localOffset=readU32(dv,pos+42),name=dec.decode(bytes.subarray(pos+46,pos+46+nameLen)).replaceAll('\\','/');
      if(readU32(dv,localOffset)!==0x04034b50)throw new Error('The ZIP has an invalid local file header.');const localNameLen=readU16(dv,localOffset+26),localExtraLen=readU16(dv,localOffset+28),dataStart=localOffset+30+localNameLen+localExtraLen,compressed=bytes.subarray(dataStart,dataStart+compSize);
      if(!name.endsWith('/'))entries.set(name,await inflateZipData(compressed,method));pos+=46+nameLen+extraLen+commentLen;
    }
    return entries;
  }
  async function importPack(file){
    if(!file)return;setStatus('opening old pack','busy');$('importStatus').className='notice';$('importStatus').textContent='Reading ZIP and checking its recordings…';
    try{
      if(state.samples.size&& !confirm('Load this previous pack and replace the current working recordings/details in the setup wizard?')){setStatus('ready');$('importStatus').className='notice';$('importStatus').innerHTML='<b>Import cancelled.</b> Your current working recordings were left alone.';return;}
      const entries=await readZipEntries(file),voicePath=[...entries.keys()].find(n=>/(^|\/)voice\.json$/i.test(n));if(!voicePath)throw new Error('I could not find voice.json inside that ZIP. Choose a MainVoice pack ZIP, not the whole app ZIP.');
      const meta=JSON.parse(new TextDecoder().decode(entries.get(voicePath))),prefix=voicePath.slice(0,-'voice.json'.length),imported=new Map();
      for(const ph of P){const key=[...entries.keys()].find(n=>n.toLowerCase()===(prefix+'samples/'+ph.c+'.wav').toLowerCase());if(!key)continue;const u8=entries.get(key),wav=u8.slice().buffer,buf=await getAudioCtx().decodeAudioData(wav.slice(0));imported.set(ph.c,{wav,duration:buf.duration,sampleRate:buf.sampleRate,updated:Date.now()})}
      let importedArt=null;const artCandidates=[meta.artFile,'character.png','character.webp','character.jpg','art.png'].filter(Boolean).map(x=>String(x).replace(/^\/+/,''));
      for(const artName of artCandidates){const key=[...entries.keys()].find(n=>n.toLowerCase()===(prefix+artName).toLowerCase());if(key){const ext=artName.toLowerCase().split('.').pop(),mime=ext==='webp'?'image/webp':ext==='jpg'||ext==='jpeg'?'image/jpeg':'image/png';importedArt={bytes:entries.get(key).slice().buffer,mime,updated:Date.now()};break}}
      if(!imported.size)throw new Error('voice.json was present, but I could not find any samples/*.wav phoneme recordings.');
      await dbClear();state.samples=imported;state.art=importedArt;renderCharacterArt();$('voiceName').value=meta.name||'My Voice';$('voiceAuthor').value=meta.author||'';$('voiceDescription').value=meta.description||'';$('voiceIntro').value=meta.introSentence||'Hello! This is my custom voice.';$('voiceIcon').value=meta.icon||'';$('voiceTags').value=Array.isArray(meta.tags)?meta.tags.join(', '):(meta.tags||'');const d=meta.defaults||{};$('defSpeed').value=d.speed??1;$('defOverlap').value=d.overlapMs??22;$('defWordGap').value=d.wordGapMs??45;$('defPitch').value=d.pitchSemitones??0;['defSpeed','defOverlap','defWordGap','defPitch'].forEach(id=>$(id).dispatchEvent(new Event('input')));
      await Promise.all([...imported].map(([c,item])=>dbPut('sample:'+c,item)));if(importedArt)await dbPut('art',importedArt);await saveMeta();refreshAll();switchTab('bank');$('importStatus').className='notice good';$('importStatus').innerHTML=`<b>Loaded ${meta.name||'previous pack'}.</b> Restored ${imported.size}/${P.length} recordings. Click any phoneme tile to redo it, then use <b>4. Test voice</b>.`;setStatus(`loaded ${imported.size}/${P.length} takes`);
    }catch(e){console.error(e);$('importStatus').className='notice bad';$('importStatus').textContent=e.message;setStatus('pack import failed','bad')}finally{$('packImport').value=''}
  }

  function next(){if(state.index<P.length-1){state.index++;refreshGuide();window.scrollTo({top:0,behavior:'smooth'})}else switchTab('bank')}
  function prev(){if(state.index>0){state.index--;refreshGuide()}}
  function firstMissing(){const i=P.findIndex(p=>!state.samples.has(p.c));state.index=i<0?0:i;switchTab('guide');refreshGuide()}
  async function deleteCurrent(){closeAudioEditor();const c=P[state.index].c;state.samples.delete(c);try{await dbDel('sample:'+c)}catch{}refreshAll()}
  async function clearAll(){if(!confirm('Delete every saved recording in this setup wizard?'))return;closeAudioEditor();const codes=[...state.samples.keys()];state.samples.clear();try{await Promise.all(codes.map(c=>dbDel('sample:'+c)))}catch{}refreshAll()}

  function slug(s){return (s||'my-voice').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64)||'my-voice'}
  function refreshExportStatus(){const n=progress(),box=$('exportStatus'),btn=$('exportZipBtn');if(n===P.length){box.className='notice good';box.innerHTML='<b>Ready.</b> All 39 phonemes are present. The ZIP can be installed directly into <code>mainvoices/</code>.';btn.disabled=false}else{box.className='notice';box.innerHTML=`<b>${P.length-n} missing.</b> Finish the recording guide before exporting so the installed voice is complete.`;btn.disabled=true}}

  /* Tiny dependency-free STORE-only ZIP writer. */
  const crcTable=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
  function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0}
  function dosTimeDate(d=new Date()){let year=Math.max(1980,d.getFullYear());const time=(d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1),date=((year-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate();return {time,date}}
  function push16(a,n){a.push(n&255,(n>>>8)&255)}function push32(a,n){a.push(n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255)}
  function makeZip(entries){
    const enc=new TextEncoder(),localParts=[],centralParts=[];let offset=0;const dt=dosTimeDate();
    for(const e of entries){const name=enc.encode(e.name),data=e.data instanceof Uint8Array?e.data:new Uint8Array(e.data),crc=crc32(data),lh=[];push32(lh,0x04034b50);push16(lh,20);push16(lh,0);push16(lh,0);push16(lh,dt.time);push16(lh,dt.date);push32(lh,crc);push32(lh,data.length);push32(lh,data.length);push16(lh,name.length);push16(lh,0);const local=new Uint8Array(lh.length+name.length+data.length);local.set(lh,0);local.set(name,lh.length);local.set(data,lh.length+name.length);localParts.push(local);
      const ch=[];push32(ch,0x02014b50);push16(ch,20);push16(ch,20);push16(ch,0);push16(ch,0);push16(ch,dt.time);push16(ch,dt.date);push32(ch,crc);push32(ch,data.length);push32(ch,data.length);push16(ch,name.length);push16(ch,0);push16(ch,0);push16(ch,0);push16(ch,0);push32(ch,0);push32(ch,offset);const central=new Uint8Array(ch.length+name.length);central.set(ch,0);central.set(name,ch.length);centralParts.push(central);offset+=local.length;
    }
    const centralSize=centralParts.reduce((n,x)=>n+x.length,0),end=[];push32(end,0x06054b50);push16(end,0);push16(end,0);push16(end,entries.length);push16(end,entries.length);push32(end,centralSize);push32(end,offset);push16(end,0);const total=offset+centralSize+end.length,out=new Uint8Array(total);let p=0;for(const x of localParts){out.set(x,p);p+=x.length}for(const x of centralParts){out.set(x,p);p+=x.length}out.set(end,p);return out;
  }
  function download(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),3000)}
  function packDefaults(){return {speed:+$('defSpeed').value,overlapMs:+$('defOverlap').value,wordGapMs:+$('defWordGap').value,pitchSemitones:+$('defPitch').value,punctuationGapMs:260}}
  async function exportZip(){
    if(progress()!==P.length)return alert('Finish all 39 recordings first.');setStatus('building ZIP','busy');
    try{
      const name=$('voiceName').value.trim()||'My Voice',id=slug(name),folder=id,tags=$('voiceTags').value.split(',').map(x=>x.trim()).filter(Boolean).slice(0,12),meta={format:'mainvoice-pack-1',id,name,author:$('voiceAuthor').value.trim(),description:$('voiceDescription').value.trim(),introSentence:$('voiceIntro').value.trim(),icon:$('voiceIcon').value.trim(),tags,artFile:state.art?'character.png':'',created:new Date().toISOString(),phonemeSet:'ARPAbet-39',phonemes:P.map(p=>p.c),sampleFormat:'mono PCM16 WAV',defaults:packDefaults()};
      const enc=new TextEncoder(),entries=[{name:`${folder}/voice.json`,data:enc.encode(JSON.stringify(meta,null,2))},{name:`${folder}/README.txt`,data:enc.encode(`MainVoice Synth voice pack: ${name}\n\nInstall: copy this entire folder into the app's mainvoices/ folder and refresh main.html.\nCharacter art, when present, is stored as character.png.\n`)}];
      if(state.art?.bytes)entries.push({name:`${folder}/character.png`,data:new Uint8Array(state.art.bytes)});
      for(const p of P){entries.push({name:`${folder}/samples/${p.c}.wav`,data:new Uint8Array(state.samples.get(p.c).wav)})}
      const zip=makeZip(entries);download(new Blob([zip],{type:'application/zip'}),`${id}-mainvoice.zip`);setStatus('ZIP exported');
    }catch(e){console.error(e);setStatus('export failed','bad');alert(e.message)}
  }

  function bindRange(id,out,fmt){const el=$(id),o=$(out);const upd=()=>o.textContent=fmt(+el.value);el.oninput=()=>{upd();saveMeta()};upd()}
  async function saveMeta(){try{await dbPut('meta',{voiceName:$('voiceName').value,voiceAuthor:$('voiceAuthor').value,voiceDescription:$('voiceDescription').value,voiceIntro:$('voiceIntro').value,voiceIcon:$('voiceIcon').value,voiceTags:$('voiceTags').value,defaults:packDefaults()})}catch{}}
  async function restore(){
    try{const all=await dbAll();for(const [k,v] of all){if(k.startsWith('sample:')){const c=k.slice(7);if(window.PHONEME_MAP[c])state.samples.set(c,v)}else if(k==='art'){state.art=v}else if(k==='meta'){if(v.voiceName)$('voiceName').value=v.voiceName;if(v.voiceAuthor)$('voiceAuthor').value=v.voiceAuthor;if(v.voiceDescription)$('voiceDescription').value=v.voiceDescription;if(v.voiceIntro!==undefined)$('voiceIntro').value=v.voiceIntro;if(v.voiceIcon!==undefined)$('voiceIcon').value=v.voiceIcon;if(v.voiceTags!==undefined)$('voiceTags').value=v.voiceTags;if(v.defaults){$('defSpeed').value=v.defaults.speed??1;$('defOverlap').value=v.defaults.overlapMs??22;$('defWordGap').value=v.defaults.wordGapMs??45;$('defPitch').value=v.defaults.pitchSemitones??0}}}setStatus(`ready · restored ${state.samples.size} take${state.samples.size===1?'':'s'}`)}catch(e){console.warn(e);setStatus('ready · autosave unavailable','bad')}finally{['defSpeed','defOverlap','defWordGap','defPitch'].forEach(id=>$(id).dispatchEvent(new Event('input')));renderCharacterArt();refreshAll()}
  }

  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
  $('hearWordBtn').onclick=hearExample;$('recordBtn').onclick=startRecording;$('stopRecordBtn').onclick=stopRecording;$('sampleUpload').onchange=e=>handleUpload(e.target.files[0]);$('packImport').onchange=e=>importPack(e.target.files[0]);$('playTakeBtn').onclick=()=>{const i=state.samples.get(P[state.index].c);if(i)playSample(i)};$('editTakeBtn').onclick=openAudioEditor;$('closeEditorBtn').onclick=closeAudioEditor;$('previewEditBtn').onclick=previewAudioEdit;$('previewRawBtn').onclick=()=>{const i=state.samples.get(P[state.index].c);if(i)playSample(i)};$('resetEditBtn').onclick=resetAudioEdit;$('saveAudioEditBtn').onclick=saveAudioEdit;$('undoAudioEditBtn').onclick=undoAudioEdit;$('healClickBtn').onclick=healEditorClick;$('redoBtn').onclick=()=>{closeAudioEditor();startRecording()};$('deleteTakeBtn').onclick=deleteCurrent;$('prevBtn').onclick=prev;$('nextBtn').onclick=next;$('firstMissingBtn').onclick=firstMissing;$('clearAllBtn').onclick=clearAll;$('bankSearch').oninput=refreshBank;$('bankFilter').onchange=refreshBank;$('testHelloBtn').onclick=()=>speakTest('hello');$('testFoxBtn').onclick=()=>speakTest('fox');$('stopTestBtn').onclick=stopTestPlayback;$('continuousHelloBtn').onclick=()=>speakContinuousTest('hello');$('continuousFoxBtn').onclick=()=>speakContinuousTest('fox');$('stopContinuousBtn').onclick=stopTestPlayback;$('fixSoundsBtn').onclick=()=>switchTab('bank');$('testToBankBtn').onclick=()=>switchTab('bank');$('exportZipBtn').onclick=exportZip;
  $('editorStart').oninput=()=>{if(!state.editor)return;state.editor.start=+$('editorStart').value/1000;updateEditorUi()};$('editorEnd').oninput=()=>{if(!state.editor)return;state.editor.end=+$('editorEnd').value/1000;updateEditorUi()};$('editorFadeIn').oninput=()=>{$('editorFadeInVal').textContent=$('editorFadeIn').value+' ms'};$('editorFadeOut').oninput=()=>{$('editorFadeOutVal').textContent=$('editorFadeOut').value+' ms'};setupWaveEditorCanvas();
  ['voiceName','voiceAuthor','voiceDescription','voiceIntro','voiceIcon','voiceTags'].forEach(id=>$(id).addEventListener('input',saveMeta));
  $('characterArtUpload').onchange=e=>handleCharacterArtUpload(e.target.files[0]);$('clearCharacterArtBtn').onclick=clearCharacterArt;$('openDoodleBtn').onclick=openDoodle;$('doodleClearBtn').onclick=clearDoodle;$('saveDoodleBtn').onclick=saveDoodle;$('doodleEraserBtn').onclick=()=>{state.doodleEraser=!state.doodleEraser;$('doodleEraserBtn').textContent='Eraser: '+(state.doodleEraser?'on':'off');$('doodleEraserBtn').classList.toggle('primary',state.doodleEraser)};setupDoodleCanvas();
  bindRange('defSpeed','defSpeedVal',v=>v.toFixed(2)+'×');bindRange('defOverlap','defOverlapVal',v=>Math.round(v)+' ms');bindRange('defWordGap','defWordGapVal',v=>Math.round(v)+' ms');bindRange('defPitch','defPitchVal',v=>(v>0?'+':'')+v+' st');
  const syncContinuousOverlap=()=>{$('continuousOverlap').value=$('defOverlap').value;$('continuousOverlapVal').textContent=Math.round(+$('defOverlap').value)+' ms'};
  const oldDefOverlapInput=$('defOverlap').oninput;$('defOverlap').oninput=e=>{oldDefOverlapInput?.call($('defOverlap'),e);syncContinuousOverlap()};
  $('continuousOverlap').oninput=()=>{$('continuousOverlapVal').textContent=Math.round(+$('continuousOverlap').value)+' ms';$('defOverlap').value=$('continuousOverlap').value;$('defOverlap').dispatchEvent(new Event('input'))};syncContinuousOverlap();
  window.addEventListener('beforeunload',()=>{state.stream?.getTracks().forEach(t=>t.stop());revokeArtUrl()});
  refreshAll();restore();
})();
