/* MainVoice Song Editor — dependency-free piano roll + concatenative singing renderer.
   Uses the active MainVoice pack and the same pitch-preserving DSP as speech. */
(() => {
  'use strict';
  const app = window.MainVoiceApp;
  if (!app) return;
  const $ = id => document.getElementById(id);
  const canvas = $('songRollCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const ROW_H = 24;
  const PX_BEAT = 82;
  const GUTTER = 62;
  const MIN_MIDI = 36; // C2
  const MAX_MIDI = 84; // C6
  const ROWS = MAX_MIDI - MIN_MIDI + 1;
  const BEATS_PER_BAR = 4;
  const UNVOICED = new Set(['P','T','K','F','TH','S','SH','CH','HH']);
  const STOPS = new Set(['P','B','T','D','K','G']);
  const AFFRICATES = new Set(['CH','JH']);
  const FRICATIVES = new Set(['F','V','TH','DH','S','Z','SH','ZH','HH']);
  const NASALS = new Set(['M','N','NG']);
  const GLIDES = new Set(['L','R','W','Y']);
  const VOWELS = new Set([...app.vowels]);
  const DIPH = new Set(['AY','AW','EY','OW','OY']);
  const SUSTAINABLE = new Set([...VOWELS,...NASALS,...FRICATIVES]);
  const PHONE_CODES = new Set(app.phonemes.map(p => p.c));

  const song = {
    notes: [], selected: null, nextId: 1, drag: null,
    source: null, playStart: 0, playRaf: 0, playheadBeat: null,
    rendered: null, variationSeed: 1
  };

  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
  function snap(){ return +$('songSnap').value || .25; }
  function q(v){ const s=snap(); return Math.round(v/s)*s; }
  function totalBeats(){ return (+$('songBars').value || 8) * BEATS_PER_BAR; }
  function bpm(){ return clamp(+$('songBpm').value || 120,30,300); }
  function secPerBeat(){ return 60/bpm(); }
  function xForBeat(b){ return GUTTER + b*PX_BEAT; }
  function beatForX(x){ return (x-GUTTER)/PX_BEAT; }
  function yForMidi(m){ return (MAX_MIDI-m)*ROW_H; }
  function midiForY(y){ return clamp(MAX_MIDI-Math.floor(y/ROW_H),MIN_MIDI,MAX_MIDI); }
  function isBlack(m){ return [1,3,6,8,10].includes((m%12+12)%12); }
  function midiName(m){ const names=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']; return names[(m%12+12)%12]+(Math.floor(m/12)-1); }
  function dbGain(db){ return Math.pow(10,db/20); }
  function noteById(id){ return song.notes.find(n=>n.id===id) || null; }
  function sortedNotes(){ return [...song.notes].sort((a,b)=>a.start-b.start || a.midi-b.midi || a.id-b.id); }
  function msg(text,bad=false){ const el=$('songMessage'); el.textContent=text; el.className='small'+(bad?' browser-pack-bad':''); }

  function songSettings(){
    return {
      bpm:bpm(), baseMidi:+$('songBaseNote').value||60, transpose:+$('songTranspose').value||0,
      legato:+$('songLegato').value||0, lead:+$('songLead').value||0,
      gainDb:+$('songGain').value||0, humanize:(+$('songHumanize').value||0)/100
    };
  }

  function resizeCanvas(){
    const logicalW=Math.ceil(GUTTER+totalBeats()*PX_BEAT+2), logicalH=ROWS*ROW_H;
    if(canvas.width!==logicalW) canvas.width=logicalW;
    if(canvas.height!==logicalH) canvas.height=logicalH;
    canvas.style.width=logicalW+'px';canvas.style.height=logicalH+'px';
    draw(); drawRuler();
  }

  function drawRuler(){
    const r=$('songRuler'); if(!r)return; r.innerHTML='';
    const inner=document.createElement('div');inner.className='song-ruler-inner';inner.style.width=canvas.width+'px';
    const spacer=document.createElement('span');spacer.style.width=GUTTER+'px';inner.appendChild(spacer);
    for(let bar=0;bar<+($('songBars').value||8);bar++){
      const s=document.createElement('span');s.style.width=(PX_BEAT*BEATS_PER_BAR)+'px';s.textContent=`${bar+1}`;inner.appendChild(s);
    }
    r.appendChild(inner);
    syncRuler();
  }
  function syncRuler(){ const r=$('songRuler'),vp=$('songRollViewport'); if(r&&vp&&r.firstElementChild) r.firstElementChild.style.transform=`translateX(${-vp.scrollLeft}px)`; }

  function noteRect(n){ return {x:xForBeat(n.start),y:yForMidi(n.midi)+2,w:Math.max(6,n.duration*PX_BEAT),h:ROW_H-4}; }
  function draw(){
    const w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);
    ctx.font='11px ui-monospace, SFMono-Regular, Menlo, monospace';ctx.textBaseline='middle';
    for(let m=MAX_MIDI;m>=MIN_MIDI;m--){
      const y=yForMidi(m);ctx.fillStyle=isBlack(m)?'#10151a':'#151b21';ctx.fillRect(0,y,w,ROW_H);
      ctx.strokeStyle='#252d35';ctx.beginPath();ctx.moveTo(0,y+.5);ctx.lineTo(w,y+.5);ctx.stroke();
      ctx.fillStyle=isBlack(m)?'#0b0f13':'#e7ebef';ctx.fillRect(0,y,GUTTER,ROW_H);
      ctx.fillStyle=isBlack(m)?'#8f9aa6':'#28313a';ctx.textAlign='right';ctx.fillText(midiName(m),GUTTER-8,y+ROW_H/2);
    }
    const beats=totalBeats();
    for(let b=0;b<=beats+1e-6;b+=snap()){
      const x=xForBeat(b),isBar=Math.abs(b%BEATS_PER_BAR)<1e-6,isBeat=Math.abs(b-Math.round(b))<1e-6;
      ctx.strokeStyle=isBar?'#596572':isBeat?'#36404a':'#252d35';ctx.lineWidth=isBar?1.5:1;ctx.beginPath();ctx.moveTo(x+.5,0);ctx.lineTo(x+.5,h);ctx.stroke();ctx.lineWidth=1;
    }
    ctx.strokeStyle='#4d5863';ctx.beginPath();ctx.moveTo(GUTTER+.5,0);ctx.lineTo(GUTTER+.5,h);ctx.stroke();

    for(const n of sortedNotes()){
      const r=noteRect(n),sel=n.id===song.selected;
      ctx.fillStyle=sel?'#ff8a2d':'#4f87a8';ctx.strokeStyle=sel?'#ffd0aa':'#83b6d4';ctx.lineWidth=sel?2:1;
      roundRect(ctx,r.x,r.y,r.w,r.h,5);ctx.fill();ctx.stroke();
      ctx.fillStyle=sel?'#27150a':'#071017';ctx.textAlign='left';ctx.font='700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      const label=(n.lyric||'la')+' · '+midiName(n.midi);ctx.save();ctx.beginPath();ctx.rect(r.x+4,r.y,r.w-8,r.h);ctx.clip();ctx.fillText(label,r.x+6,r.y+r.h/2);ctx.restore();
      ctx.fillStyle=sel?'#fff0e3':'#b9d9eb';ctx.fillRect(r.x+r.w-4,r.y+3,2,r.h-6);
    }
    if(song.playheadBeat!=null){const x=xForBeat(song.playheadBeat);ctx.strokeStyle='#ffcf66';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();ctx.lineWidth=1;}
  }
  function roundRect(c,x,y,w,h,r){r=Math.min(r,w/2,h/2);c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}

  function point(e){const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*(canvas.width/r.width),y:(e.clientY-r.top)*(canvas.height/r.height)};}
  function hitNote(x,y){
    const list=[...song.notes].reverse();
    for(const n of list){const r=noteRect(n);if(x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h)return {note:n,edge:x>r.x+r.w-11};}
    return null;
  }
  function selectNote(id){song.selected=id;updateInspector();draw();}
  function addNote(start,midi,duration=1,lyric='la'){
    const n={id:song.nextId++,start:clamp(q(start),0,Math.max(0,totalBeats()-snap())),duration:Math.max(snap(),q(duration)),midi:clamp(Math.round(midi),MIN_MIDI,MAX_MIDI),lyric,phones:'',velocity:100};
    if(n.start+n.duration>totalBeats())n.duration=Math.max(snap(),totalBeats()-n.start);song.notes.push(n);selectNote(n.id);invalidate();return n;
  }
  function invalidate(){song.rendered=null;draw();}

  canvas.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;canvas.setPointerCapture?.(e.pointerId);const p=point(e),hit=hitNote(p.x,p.y),beat=beatForX(p.x),midi=midiForY(p.y);
    if(p.x<GUTTER)return;
    if(hit){selectNote(hit.note.id);song.drag={mode:hit.edge?'resize':'move',id:hit.note.id,grabBeat:beat-hit.note.start,grabMidi:midi-hit.note.midi};}
    else{const n=addNote(beat,midi,1,'la');song.drag={mode:'new',id:n.id,grabBeat:0,grabMidi:0};}
    e.preventDefault();
  });
  canvas.addEventListener('pointermove',e=>{
    if(!song.drag)return;const n=noteById(song.drag.id);if(!n)return;const p=point(e),beat=beatForX(p.x),midi=midiForY(p.y);
    if(song.drag.mode==='move'){
      n.start=clamp(q(beat-song.drag.grabBeat),0,Math.max(0,totalBeats()-n.duration));n.midi=clamp(midi-song.drag.grabMidi,MIN_MIDI,MAX_MIDI);
    }else{
      n.duration=clamp(Math.max(snap(),q(beat-n.start)),snap(),Math.max(snap(),totalBeats()-n.start));
    }
    updateInspector(false);invalidate();
  });
  const endDrag=()=>{song.drag=null;};canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);
  canvas.addEventListener('dblclick',e=>{const p=point(e),h=hitNote(p.x,p.y);if(h){selectNote(h.note.id);$('songNoteLyric').focus();$('songNoteLyric').select();}});
  document.addEventListener('keydown',e=>{if(e.key!=='Delete'&&e.key!=='Backspace')return;if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;if(song.selected){deleteSelected();e.preventDefault();}});

  function parseOverride(text){
    const bad=[],phones=[];for(const raw of String(text||'').toUpperCase().split(/\s+/).filter(Boolean)){const code=raw.replace(/[012]$/,'');if(PHONE_CODES.has(code))phones.push({code,stress:+(raw.match(/[012]$/)?.[0]||0)});else bad.push(raw)}return {phones,bad};
  }
  function resolvedPhones(n){
    if(String(n.phones||'').trim()){const p=parseOverride(n.phones);return {detailed:p.phones,bad:p.bad,unknown:false};}
    const lyric=String(n.lyric||'la').trim()||'la';const r=app.wordPron(lyric);return {detailed:r.detailed||r.phones.map(code=>({code,stress:0})),bad:[],unknown:r.unknown};
  }
  function autoPhoneText(n){const r=resolvedPhones(n);return r.bad.length?'⚠ '+r.bad.join(' '):r.detailed.map(p=>p.code+(p.stress?String(p.stress):'')).join(' ');}
  function updateInspector(full=true){
    const n=noteById(song.selected),empty=$('songNoSelection'),panel=$('songNoteInspector');empty.hidden=!!n;panel.hidden=!n;if(!n)return;
    $('songSelectedPitch').textContent=midiName(n.midi);
    if(full){$('songNoteLyric').value=n.lyric||'';$('songNotePhones').value=n.phones||'';$('songNoteVelocity').value=n.velocity??100;}
    $('songNoteStart').value=trimNum(n.start);$('songNoteDuration').value=trimNum(n.duration);$('songNoteVelocityVal').textContent=Math.round(n.velocity??100)+'%';
    const r=resolvedPhones(n);$('songNoteAutoPhones').textContent=autoPhoneText(n);const vc=r.detailed.filter(p=>VOWELS.has(p.code)).length;
    $('songNoteHint').textContent=r.bad.length?'Fix the unknown ARPAbet codes above.':vc>1?'This lyric has multiple vowel nuclei. It will work, but splitting it into syllables across multiple notes usually sings more clearly.':r.unknown?'Fallback pronunciation is being used; use the ARPAbet override if it sounds wrong.':'Pronunciation ready.';
  }
  function trimNum(v){return String(Math.round(v*1000)/1000);}
  function selectedChange(fn){const n=noteById(song.selected);if(!n)return;fn(n);invalidate();updateInspector(false);}
  $('songNoteLyric').addEventListener('input',e=>selectedChange(n=>{n.lyric=e.target.value;n.phones='';$('songNotePhones').value='';updateInspector(false);}));
  $('songNotePhones').addEventListener('input',e=>selectedChange(n=>{n.phones=e.target.value;updateInspector(false);}));
  $('songNoteStart').addEventListener('change',e=>selectedChange(n=>{n.start=clamp(q(+e.target.value||0),0,Math.max(0,totalBeats()-n.duration));}));
  $('songNoteDuration').addEventListener('change',e=>selectedChange(n=>{n.duration=clamp(Math.max(snap(),q(+e.target.value||snap())),snap(),Math.max(snap(),totalBeats()-n.start));}));
  $('songNoteVelocity').addEventListener('input',e=>selectedChange(n=>{n.velocity=+e.target.value||100;$('songNoteVelocityVal').textContent=Math.round(n.velocity)+'%';}));
  function deleteSelected(){if(!song.selected)return;song.notes=song.notes.filter(n=>n.id!==song.selected);song.selected=null;updateInspector();invalidate();}
  $('songNoteDeleteBtn').onclick=deleteSelected;
  $('songNoteDuplicateBtn').onclick=()=>{const n=noteById(song.selected);if(!n)return;const copy={...n,id:song.nextId++,start:clamp(q(n.start+n.duration),0,Math.max(0,totalBeats()-n.duration))};song.notes.push(copy);selectNote(copy.id);invalidate();};

  function phoneFixedDuration(code){
    if(STOPS.has(code))return .055;if(AFFRICATES.has(code))return .085;if(FRICATIVES.has(code))return .10;if(GLIDES.has(code))return .085;if(NASALS.has(code))return .09;return .075;
  }
  function sourceWindow(code,source){
    // Singing keeps more of the original take than speech mode so the one-time
    // attack/release character survives. Long notes stretch only the stable
    // middle region; they never loop this complete window.
    if(VOWELS.has(code))return Math.min(source.duration,DIPH.has(code) ? .95 : .82);
    if(NASALS.has(code))return Math.min(source.duration,.66);
    if(FRICATIVES.has(code))return Math.min(source.duration,.56);
    if(GLIDES.has(code))return Math.min(source.duration,.30);
    if(AFFRICATES.has(code))return Math.min(source.duration,.22);
    if(STOPS.has(code))return Math.min(source.duration,.17);
    return Math.min(source.duration,.34);
  }
  function sustainProfile(code,source,win){
    const d=Math.max(.03,Math.min(source.duration,win));
    if(DIPH.has(code))return {attackSeconds:Math.min(.085,d*.18),releaseSeconds:Math.min(.22,d*.38),crossfadeSeconds:.012};
    if(VOWELS.has(code))return {attackSeconds:Math.min(.075,d*.19),releaseSeconds:Math.min(.070,d*.18),crossfadeSeconds:.011};
    if(NASALS.has(code))return {attackSeconds:Math.min(.055,d*.17),releaseSeconds:Math.min(.050,d*.16),crossfadeSeconds:.009};
    if(FRICATIVES.has(code))return {attackSeconds:Math.min(.040,d*.14),releaseSeconds:Math.min(.040,d*.14),crossfadeSeconds:.008};
    return {attackSeconds:Math.min(.05,d*.18),releaseSeconds:Math.min(.05,d*.18),crossfadeSeconds:.009};
  }
  function hash01(id,salt=0){let x=((id+1)*0x9e3779b1^(song.variationSeed+salt)*0x85ebca6b)>>>0;x^=x>>>16;x=Math.imul(x,0x7feb352d);x^=x>>>15;x=Math.imul(x,0x846ca68b);x^=x>>>16;return (x>>>0)/4294967295;}
  function notePlan(n,settings,startOverride=null){
    const rp=resolvedPhones(n);if(rp.bad.length)throw new Error(`Note “${n.lyric||'la'}” has unknown ARPAbet: ${rp.bad.join(', ')}`);const phones=rp.detailed;if(!phones.length)return [];
    const beatSec=60/settings.bpm,human=settings.humanize,timingJitter=(hash01(n.id,1)*2-1)*.010*human,pitchJitter=(hash01(n.id,2)*2-1)*.08*human;
    const noteStart=(startOverride==null?n.start*beatSec:startOverride)+timingJitter,noteDur=Math.max(.06,n.duration*beatSec),noteEnd=noteStart+noteDur;
    const firstV=phones.findIndex(p=>VOWELS.has(p.code)),lastV=(()=>{let z=-1;phones.forEach((p,i)=>{if(VOWELS.has(p.code))z=i});return z})();
    const events=[],targetPitch=n.midi-settings.baseMidi+settings.transpose+pitchJitter,gainDb=20*Math.log10(Math.max(.05,(n.velocity??100)/100));
    if(firstV<0){
      const each=Math.max(.035,noteDur/phones.length);let cur=noteStart;for(const p of phones){events.push({code:p.code,start:cur,dur:each,pitch:UNVOICED.has(p.code)?0:targetPitch,gainDb});cur+=each;}return events;
    }
    const leading=phones.slice(0,firstV),body=phones.slice(firstV),leadDesired=leading.reduce((a,p)=>a+phoneFixedDuration(p.code),0),preRoll=Math.min(leadDesired,settings.lead/1000),leadStart=Math.max(0,noteStart-preRoll);let cur=leadStart;
    for(const p of leading){const dur=phoneFixedDuration(p.code);events.push({code:p.code,start:cur,dur,pitch:UNVOICED.has(p.code)?0:targetPitch,gainDb});cur+=dur;}
    const bodyStart=Math.max(noteStart,cur-settings.legato/1000*.35),available=Math.max(.045,noteEnd-bodyStart),vowels=body.filter(p=>VOWELS.has(p.code));
    let fixed=body.filter(p=>!VOWELS.has(p.code)).reduce((a,p)=>a+phoneFixedDuration(p.code),0),fixedScale=fixed>available*.43?(available*.43/fixed):1;fixed*=fixedScale;
    const vowelSpace=Math.max(.025*vowels.length,available-fixed),weights=vowels.map(p=>(p.stress===1?1.22:p.stress===2?1.10:1)*(DIPH.has(p.code)?1.13:1)),sumW=weights.reduce((a,b)=>a+b,0)||1;let vi=0;cur=bodyStart;
    for(let i=0;i<body.length;i++){
      const p=body[i],isV=VOWELS.has(p.code),dur=isV?vowelSpace*(weights[vi++]/sumW):phoneFixedDuration(p.code)*fixedScale;
      const ov=Math.min(settings.legato/1000,isV?.035:.014,dur*.28);events.push({code:p.code,start:cur,dur:Math.max(.025,dur),pitch:UNVOICED.has(p.code)?0:targetPitch,gainDb});cur+=Math.max(.012,dur-ov);
    }
    // Keep trailing consonants close to the written note end rather than letting a
    // very long vowel push them far beyond the grid cell.
    if(lastV>=0&&events.length){const end=Math.max(...events.map(e=>e.start+e.dur));if(end>noteEnd+.08){const shift=end-(noteEnd+.08);for(let i=Math.max(0,events.length-(phones.length-lastV-1));i<events.length;i++)events[i].start=Math.max(noteStart,events[i].start-shift);}}
    return events;
  }

  async function renderSong(onlyNote=null){
    if(!app.voice)throw new Error('Pick/load a MainVoice first.');if(!app.buffers?.size)throw new Error('The selected voice has no decoded phoneme samples.');
    const settings=songSettings(),notes=onlyNote?[{...onlyNote,start:0}]:sortedNotes();if(!notes.length)throw new Error('Draw at least one note first.');
    const plans=[];for(const n of notes)plans.push(...notePlan(n,settings,onlyNote ? .08 : null));
    const missing=[...new Set(plans.filter(e=>!app.buffers.has(e.code)).map(e=>e.code))];if(missing.length)throw new Error('This voice is missing: '+missing.join(', '));
    const sr=48000,temp=new OfflineAudioContext(1,sr,sr),cache=new Map(),renderEvents=[];
    for(const e of plans){
      const source=app.buffers.get(e.code),win=sourceWindow(e.code,source),target=Math.max(.018,e.dur),pitchQ=Math.round(e.pitch*20)/20,durQ=Math.round(target*1000)/1000;
      const canSustain=SUSTAINABLE.has(e.code),natural=Math.min(source.duration,win),useSustain=canSustain&&target>natural*1.04;
      const key=`${e.code}|${pitchQ}|${durQ}|${useSustain?'hold':'short'}`;
      let buf=cache.get(key);
      if(!buf){
        if(useSustain){
          const prof=sustainProfile(e.code,source,win);
          buf=MainVoiceDSP.sustainToAudioBuffer(temp,source,{pitchSemitones:pitchQ,targetSeconds:target,maxSourceSeconds:win,...prof});
        }else{
          const speed=clamp(win/target,.08,8);
          buf=MainVoiceDSP.toAudioBuffer(temp,source,{pitchSemitones:pitchQ,speed,maxSourceSeconds:win});
        }
        cache.set(key,buf);
      }
      renderEvents.push({...e,buffer:buf});
    }
    const end=Math.max(...renderEvents.map(e=>e.start+e.buffer.duration),.2)+.18,length=Math.ceil(end*sr),off=new OfflineAudioContext(1,length,sr),master=off.createGain(),comp=off.createDynamicsCompressor();master.gain.value=dbGain(settings.gainDb);comp.threshold.value=-7;comp.knee.value=8;comp.ratio.value=3;comp.attack.value=.004;comp.release.value=.14;master.connect(comp);comp.connect(off.destination);
    for(const e of renderEvents){const s=off.createBufferSource(),g=off.createGain(),start=Math.max(0,e.start);s.buffer=e.buffer;s.connect(g);g.connect(master);const peak=dbGain(e.gainDb),dur=e.buffer.duration,fade=Math.min(.012,Math.max(.0025,settings.legato/1000*.35),dur*.20);g.gain.setValueAtTime(0,start);g.gain.linearRampToValueAtTime(peak,start+fade);g.gain.setValueAtTime(peak,Math.max(start+fade,start+dur-fade));g.gain.linearRampToValueAtTime(0,start+dur);s.start(start);}
    return off.startRendering();
  }

  function stopSong(){if(song.source){try{song.source.stop()}catch{}song.source=null}cancelAnimationFrame(song.playRaf);song.playRaf=0;song.playheadBeat=null;draw();}
  function animatePlayhead(){if(!song.source)return;const elapsed=(performance.now()-song.playStart)/1000;song.playheadBeat=elapsed/secPerBeat();if(song.playheadBeat<=totalBeats()+1){draw();song.playRaf=requestAnimationFrame(animatePlayhead);}else stopSong();}
  async function playBuffer(buf,withPlayhead=false){stopSong();app.stopSpeech?.();const ac=app.getAudioCtx(),s=ac.createBufferSource();s.buffer=buf;s.connect(ac.destination);s.start();song.source=s;if(withPlayhead){song.playStart=performance.now();animatePlayhead()}s.onended=()=>{if(song.source===s){song.source=null;cancelAnimationFrame(song.playRaf);song.playRaf=0;song.playheadBeat=null;draw();}};}
  async function playSong(){try{msg('Rendering singing voice…');app.setStatus?.('rendering song','busy');$('songPlayBtn').disabled=true;const b=await renderSong();song.rendered=b;await playBuffer(b,true);msg(`Playing ${song.notes.length} note${song.notes.length===1?'':'s'} with ${app.voice.name}.`);app.setStatus?.('playing song');}catch(e){console.error(e);msg(e.message,true);app.setStatus?.('song render failed','bad')}finally{$('songPlayBtn').disabled=false}}
  async function auditionSelected(){const n=noteById(song.selected);if(!n)return;try{msg(`Rendering ${n.lyric||'la'} on ${midiName(n.midi)}…`);const b=await renderSong(n);await playBuffer(b,false);msg(`Audition: ${n.lyric||'la'} · ${midiName(n.midi)}`);}catch(e){msg(e.message,true)}}
  async function exportSong(){try{msg('Rendering WAV…');app.setStatus?.('rendering song WAV','busy');const b=await renderSong();song.rendered=b;const safe=String($('songTitle').value||'mainvoice-song').trim().replace(/[^a-z0-9_-]+/gi,'-').replace(/^-+|-+$/g,'')||'mainvoice-song';app.download(new Blob([app.encodeWav(b)],{type:'audio/wav'}),safe+'.wav');msg('Song WAV exported.');app.setStatus?.('song WAV exported');}catch(e){msg(e.message,true);app.setStatus?.('song export failed','bad')}}
  $('songPlayBtn').onclick=playSong;$('songStopBtn').onclick=stopSong;$('songExportBtn').onclick=exportSong;$('songNoteAuditionBtn').onclick=auditionSelected;

  function projectObject(){const s=songSettings();return {format:'mainvoice-song-1',title:$('songTitle').value||'Untitled MainVoice Song',voiceHint:app.voice?.id||'',bpm:s.bpm,bars:+$('songBars').value||8,snap:snap(),baseMidi:s.baseMidi,transpose:s.transpose,legatoMs:s.legato,consonantLeadMs:s.lead,gainDb:s.gainDb,humanize:Math.round(s.humanize*100),notes:sortedNotes().map(n=>({...n}))};}
  $('songSaveBtn').onclick=()=>{const p=projectObject(),name=String(p.title).trim().replace(/[^a-z0-9_-]+/gi,'-')||'mainvoice-song';app.download(new Blob([JSON.stringify(p,null,2)],{type:'application/json'}),name+'.mainvoice-song.json');msg('Song project saved.');};
  $('songLoadInput').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const p=JSON.parse(await f.text());if(p.format!=='mainvoice-song-1')throw new Error('That is not a MainVoice song project.');$('songTitle').value=p.title||'Untitled MainVoice Song';$('songBpm').value=clamp(+p.bpm||120,30,300);$('songBars').value=[4,8,16,32].includes(+p.bars)?+p.bars:8;$('songSnap').value=String([1,.5,.25,.125].includes(+p.snap)?+p.snap:.25);$('songBaseNote').value=String(clamp(+p.baseMidi||60,MIN_MIDI,MAX_MIDI));$('songTranspose').value=String(clamp(+p.transpose||0,-24,24));$('songLegato').value=clamp(+p.legatoMs||18,0,80);$('songLead').value=clamp(+p.consonantLeadMs||45,0,140);$('songGain').value=clamp(+p.gainDb||0,-18,6);$('songHumanize').value=clamp(+p.humanize||0,0,100);song.notes=(Array.isArray(p.notes)?p.notes:[]).map((n,i)=>({id:+n.id||i+1,start:Math.max(0,+n.start||0),duration:Math.max(.125,+n.duration||1),midi:clamp(Math.round(+n.midi||60),MIN_MIDI,MAX_MIDI),lyric:String(n.lyric||'la'),phones:String(n.phones||''),velocity:clamp(+n.velocity||100,20,160)}));song.nextId=Math.max(0,...song.notes.map(n=>n.id))+1;song.selected=song.notes[0]?.id||null;refreshControlOutputs();resizeCanvas();updateInspector();invalidate();if(p.voiceHint&&app.voices.some(v=>v.id===p.voiceHint))await app.loadVoice(p.voiceHint);msg(`Loaded ${song.notes.length} notes from ${f.name}.`);}catch(err){msg(err.message,true)}finally{e.target.value='';}};

  $('songApplyLyricsBtn').onclick=()=>{const parts=String($('songLyricsBatch').value||'').trim().split(/\s+/).filter(Boolean),notes=sortedNotes();if(!parts.length||!notes.length){msg('Add some notes and type lyrics first.',true);return}notes.forEach((n,i)=>{if(parts[i]!=null){n.lyric=parts[i];n.phones='';}});if(song.selected)updateInspector();invalidate();msg(`Applied ${Math.min(parts.length,notes.length)} lyric token${Math.min(parts.length,notes.length)===1?'':'s'} to the notes.`);};
  $('songDemoBtn').onclick=()=>{song.notes=[];song.nextId=1;const pattern=[60,62,64,67,67,64,62,60,60,62,64,62,60];const lens=[1,1,1,1,1,1,1,1,1,1,1,1,2];let b=0;pattern.forEach((m,i)=>{const n={id:song.nextId++,start:b,duration:lens[i],midi:m,lyric:'la',phones:'',velocity:i===3||i===4?112:100};song.notes.push(n);b+=lens[i]});song.selected=song.notes[0].id;$('songBars').value='4';resizeCanvas();updateInspector();invalidate();msg('Loaded a simple “la” demo melody. Drag the notes around or replace the lyrics.');};
  $('songClearBtn').onclick=()=>{if(song.notes.length&&!confirm('Clear every note in this song?'))return;stopSong();song.notes=[];song.selected=null;updateInspector();invalidate();msg('Piano roll cleared.');};

  function populateNoteSelectors(){
    const base=$('songBaseNote');base.innerHTML='';for(let m=MIN_MIDI;m<=MAX_MIDI;m++){const o=document.createElement('option');o.value=m;o.textContent=midiName(m);if(m===60)o.selected=true;base.appendChild(o)}
    const tr=$('songTranspose');tr.innerHTML='';for(let n=-24;n<=24;n++){const o=document.createElement('option');o.value=n;o.textContent=(n>0?'+':'')+n+' st';if(n===0)o.selected=true;tr.appendChild(o)}
  }
  function populateVoices(){const sel=$('songVoiceSelect'),voices=app.voices||[];sel.innerHTML='';if(!voices.length){sel.innerHTML='<option value="">No voice loaded yet</option>';return}for(const v of voices){const o=document.createElement('option');o.value=v.id;o.textContent=(v.icon?v.icon+' ':'')+v.name+(v.temporary?' [browser test]':'');o.selected=app.voice?.id===v.id;sel.appendChild(o)}}
  $('songVoiceSelect').onchange=e=>app.loadVoice(e.target.value);document.addEventListener('mainvoice:voiceschange',populateVoices);document.addEventListener('mainvoice:voicechange',()=>{populateVoices();msg(`Active singing voice: ${app.voice?.name||'none'}.`)});

  function refreshControlOutputs(){
    $('songLegatoVal').textContent=Math.round(+$('songLegato').value)+' ms';$('songLeadVal').textContent=Math.round(+$('songLead').value)+' ms';$('songGainVal').textContent=((+$('songGain').value)>0?'+':'')+Math.round(+$('songGain').value)+' dB';$('songHumanizeVal').textContent=Math.round(+$('songHumanize').value)+'%';song.rendered=null;
  }
  for(const id of ['songLegato','songLead','songGain','songHumanize'])$(id).addEventListener('input',refreshControlOutputs);
  for(const id of ['songBpm','songSnap','songBaseNote','songTranspose'])$(id).addEventListener('change',()=>{refreshControlOutputs();draw();updateInspector(false)});
  $('songBars').addEventListener('change',()=>{const max=totalBeats();for(const n of song.notes){n.start=clamp(n.start,0,Math.max(0,max-snap()));n.duration=Math.max(snap(),Math.min(n.duration,max-n.start))}resizeCanvas();updateInspector(false);invalidate()});
  $('songRollViewport').addEventListener('scroll',syncRuler);

  populateNoteSelectors();populateVoices();refreshControlOutputs();resizeCanvas();updateInspector();
})();
