/* MainVoice Vocal DAW — dependency-free piano roll, slides, vibrato, pitch curves,
   vocal layers, backing-track mixing, looping, and pitch-preserving singing.
   Voicebank creation/editor code is intentionally untouched. */
(() => {
  'use strict';
  const app = window.MainVoiceApp;
  if (!app) return;
  const $ = id => document.getElementById(id);
  const canvas = $('songRollCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const pitchCanvas = $('songPitchCurve');
  const pitchCtx = pitchCanvas?.getContext('2d') || null;

  const MIN_MIDI = 36; // C2
  const MAX_MIDI = 84; // C6
  const BEATS_PER_BAR = 4;
  const GUTTER = 64;
  const PHONE_CODES = new Set(app.phonemes.map(p => p.c));
  const UNVOICED = new Set(['P','T','K','F','TH','S','SH','CH','HH']);
  const STOPS = new Set(['P','B','T','D','K','G']);
  const AFFRICATES = new Set(['CH','JH']);
  const FRICATIVES = new Set(['F','V','TH','DH','S','Z','SH','ZH','HH']);
  const NASALS = new Set(['M','N','NG']);
  const GLIDES = new Set(['L','R','W','Y']);
  const VOWELS = new Set([...app.vowels]);
  const DIPH = new Set(['AY','AW','EY','OW','OY']);
  const SUSTAINABLE = new Set([...VOWELS,...NASALS,...FRICATIVES]);
  const DYNAMIC_PITCH_OK = new Set([...VOWELS,...NASALS,'V','DH','Z','ZH','L','R','W','Y']);
  const TRACK_COLORS = ['#55a7d6','#d981c8','#7bcf92','#efae5a','#9a8cff','#66c9c2','#e87777','#b8c65b'];

  const song = {
    notes: [], tracks: [], activeTrack: 1, selected: new Set(), primary: null,
    nextId: 1, nextTrackId: 2, tool: 'pencil', drag: null, marquee: null,
    slideSource: null, clipboard: [], undo: [], redo: [], historyLock: false,
    source: null, playStartMs: 0, playStartBeat: 0, playRaf: 0,
    playheadBeat: null, cursorBeat: 0, rendered: null, variationSeed: 1,
    backing: {buffer:null, name:'', gainDb:-8, offsetBeats:0, mute:false},
    pitchDrag: null, autosaveTimer:0, autosaveReady:false
  };
  const SONG_AUTOSAVE_KEY='mainvoice.song.autosave.v3';

  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
  function trimNum(v){ return String(Math.round(v*1000)/1000); }
  function dbGain(db){ return Math.pow(10,db/20); }
  function esc(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function midiName(m){ const n=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']; return n[(m%12+12)%12]+(Math.floor(m/12)-1); }
  function isBlack(m){ return [1,3,6,8,10].includes((m%12+12)%12); }
  function snap(){ return +$('songSnap').value || .25; }
  function q(v){ const s=snap(); return s > 0 ? Math.round(v/s)*s : v; }
  function totalBeats(){ return (+$('songBars').value || 8) * BEATS_PER_BAR; }
  function bpm(){ return clamp(+$('songBpm').value || 120,30,300); }
  function secPerBeat(){ return 60/bpm(); }
  function pxBeat(){ return +$('songZoomX').value || 82; }
  function rowH(){ return +$('songZoomY').value || 24; }
  function canvasHeight(){ return (MAX_MIDI-MIN_MIDI+1)*rowH(); }
  function xForBeat(b){ return GUTTER + b*pxBeat(); }
  function beatForX(x){ return (x-GUTTER)/pxBeat(); }
  function yForMidi(m){ return (MAX_MIDI-m)*rowH(); }
  function midiForY(y){ return clamp(MAX_MIDI-Math.floor(y/rowH()),MIN_MIDI,MAX_MIDI); }
  function noteById(id){ return song.notes.find(n=>n.id===id) || null; }
  function trackById(id){ return song.tracks.find(t=>t.id===id) || song.tracks[0] || null; }
  function voiceById(id){return app.voices.find(v=>v.id===id)||null}
  function fallbackVoiceId(){return app.voice?.id||app.voices?.[0]?.id||''}
  function ensureTrackVoices(){const f=fallbackVoiceId();for(const t of song.tracks)if(!voiceById(t.voiceId))t.voiceId=f}
  function sortedNotes(){ return [...song.notes].sort((a,b)=>a.start-b.start || a.midi-b.midi || a.id-b.id); }
  function selectedNotes(){ return song.notes.filter(n=>song.selected.has(n.id)); }
  function msg(text,bad=false){ const el=$('songMessage'); if(!el)return; el.textContent=text; el.className='small'+(bad?' browser-pack-bad':''); }
  function setDirty(){ song.rendered=null; draw(); drawPitchCurve(); scheduleAutosave(); }
  function setAutosaveStatus(text){const el=$('songAutosaveStatus');if(el)el.textContent=text}
  function scheduleAutosave(){if(!song.autosaveReady)return;clearTimeout(song.autosaveTimer);song.autosaveTimer=setTimeout(()=>{try{const p=projectObject();p._autosavedAt=Date.now();localStorage.setItem(SONG_AUTOSAVE_KEY,JSON.stringify(p));setAutosaveStatus('Autosaved locally · '+new Date(p._autosavedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}))}catch(e){setAutosaveStatus('Autosave unavailable: '+e.message)}},450)}

  function defaultTrack(){ return {id:1,name:'Lead',voiceId:app.voice?.id||app.voices?.[0]?.id||'',gainDb:0,pan:0,transpose:0,delayBeats:0,mute:false,solo:false,color:TRACK_COLORS[0]}; }
  function defaultNote(id,start,midi,duration=1,lyric='la'){
    return {
      id,start,duration,midi,lyric,phones:'',velocity:100,trackId:song.activeTrack,
      fineCents:0,slideFrom:null,slideBeats:.35,slideCurve:'smooth',
      vibratoDepth:0,vibratoRate:5.5,vibratoDelay:45,vibratoFade:20,
      pitchPoints:[]
    };
  }

  function songSettings(){
    return {
      bpm:bpm(), baseMidi:+$('songBaseNote').value||60, transpose:+$('songTranspose').value||0,
      legato:+$('songLegato').value||0, lead:+$('songLead').value||0,
      gainDb:+$('songGain').value||0, humanize:(+$('songHumanize').value||0)/100,
      loop:$('songLoop').checked, loopStart:clamp(+$('songLoopStart').value||0,0,totalBeats()),
      loopEnd:clamp(+$('songLoopEnd').value||totalBeats(),0,totalBeats())
    };
  }

  // ---------- history ----------
  function coreState(){
    return JSON.stringify({
      notes:song.notes,tracks:song.tracks,activeTrack:song.activeTrack,nextId:song.nextId,nextTrackId:song.nextTrackId,
      selected:[...song.selected],primary:song.primary,slideSource:song.slideSource
    });
  }
  function remember(){ if(song.historyLock)return; song.undo.push(coreState()); if(song.undo.length>80)song.undo.shift(); song.redo.length=0; updateUndoButtons(); }
  function restoreCore(raw){
    const s=JSON.parse(raw); song.historyLock=true;
    song.notes=s.notes||[];song.tracks=s.tracks?.length?s.tracks:[defaultTrack()];song.activeTrack=s.activeTrack||song.tracks[0].id;
    song.nextId=s.nextId||Math.max(0,...song.notes.map(n=>n.id))+1;song.nextTrackId=s.nextTrackId||Math.max(1,...song.tracks.map(t=>t.id))+1;
    song.selected=new Set(s.selected||[]);song.primary=s.primary||null;song.slideSource=s.slideSource||null;song.historyLock=false;
    renderTracks();updateInspector();setDirty();updateUndoButtons();
  }
  function undo(){ if(!song.undo.length)return; song.redo.push(coreState()); restoreCore(song.undo.pop()); msg('Undo.'); }
  function redo(){ if(!song.redo.length)return; song.undo.push(coreState()); restoreCore(song.redo.pop()); msg('Redo.'); }
  function updateUndoButtons(){ $('songUndoBtn').disabled=!song.undo.length; $('songRedoBtn').disabled=!song.redo.length; }

  // ---------- selection / tools ----------
  function setTool(tool){
    song.tool=tool;song.slideSource=null;
    document.querySelectorAll('[data-song-tool]').forEach(b=>b.classList.toggle('active',b.dataset.songTool===tool));
    canvas.dataset.tool=tool;
    msg(tool==='slide'?'Slide tool: click the source note, then the target note.':'Tool: '+tool+'.');
    draw();
  }
  function selectOnly(id){ song.selected=new Set(id?[id]:[]); song.primary=id||null; updateInspector(); draw(); }
  function toggleSelect(id){ if(song.selected.has(id))song.selected.delete(id);else song.selected.add(id); song.primary=song.selected.has(id)?id:[...song.selected].at(-1)||null; updateInspector(); draw(); }
  function addSelect(id){ song.selected.add(id);song.primary=id;updateInspector();draw(); }
  function deleteSelected(){
    if(!song.selected.size)return;remember();const ids=new Set(song.selected);song.notes=song.notes.filter(n=>!ids.has(n.id));
    for(const n of song.notes)if(ids.has(n.slideFrom))n.slideFrom=null;
    song.selected.clear();song.primary=null;updateInspector();setDirty();msg(`Deleted ${ids.size} note${ids.size===1?'':'s'}.`);
  }
  function duplicateSelected(){
    const sel=selectedNotes();if(!sel.length)return;remember();const ids=[];const shift=Math.max(snap(),.25);
    for(const n of sel){const c=structuredClone(n);c.id=song.nextId++;c.start=clamp(q(n.start+shift),0,Math.max(0,totalBeats()-n.duration));c.slideFrom=null;song.notes.push(c);ids.push(c.id)}
    song.selected=new Set(ids);song.primary=ids.at(-1);updateInspector();setDirty();
  }
  function copySelected(){song.clipboard=selectedNotes().map(n=>structuredClone(n));msg(song.clipboard.length?`Copied ${song.clipboard.length} note${song.clipboard.length===1?'':'s'}.`:'Nothing selected.');}
  function pasteClipboard(){
    if(!song.clipboard.length)return;remember();const min=Math.min(...song.clipboard.map(n=>n.start)),target=q(song.cursorBeat||0),delta=target-min,ids=[];
    for(const n of song.clipboard){const c=structuredClone(n);c.id=song.nextId++;c.start=clamp(q(n.start+delta),0,Math.max(0,totalBeats()-n.duration));c.slideFrom=null;song.notes.push(c);ids.push(c.id)}
    song.selected=new Set(ids);song.primary=ids.at(-1);updateInspector();setDirty();msg(`Pasted ${ids.length} note${ids.length===1?'':'s'} at beat ${trimNum(target)}.`);
  }

  // ---------- canvas geometry / drawing ----------
  function resizeCanvas(){
    const w=Math.ceil(GUTTER+totalBeats()*pxBeat()+2),h=canvasHeight();
    if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;
    canvas.style.width=w+'px';canvas.style.height=h+'px';drawRuler();draw();
  }
  function noteRect(n){ return {x:xForBeat(n.start),y:yForMidi(n.midi)+2,w:Math.max(6,n.duration*pxBeat()),h:rowH()-4}; }
  function roundRect(c,x,y,w,h,r){r=Math.min(r,w/2,h/2);c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}
  function trackColor(id){const t=trackById(id);return t?.color||TRACK_COLORS[0];}
  function drawRuler(){
    const r=$('songRuler');if(!r)return;r.innerHTML='';const inner=document.createElement('div');inner.className='song-ruler-inner';inner.style.width=canvas.width+'px';
    const spacer=document.createElement('span');spacer.style.width=GUTTER+'px';inner.appendChild(spacer);
    const bars=+$('songBars').value||8;for(let bar=0;bar<bars;bar++){const s=document.createElement('span');s.style.width=(pxBeat()*BEATS_PER_BAR)+'px';s.textContent=`${bar+1}`;inner.appendChild(s)}r.appendChild(inner);syncRuler();
  }
  function syncRuler(){const r=$('songRuler'),vp=$('songRollViewport');if(r&&vp&&r.firstElementChild)r.firstElementChild.style.transform=`translateX(${-vp.scrollLeft}px)`;}
  function automationValue(n,frac){
    const pts=[{x:0,cents:0},...(n.pitchPoints||[]),{x:1,cents:0}].sort((a,b)=>a.x-b.x);frac=clamp(frac,0,1);
    for(let i=0;i<pts.length-1;i++){const a=pts[i],b=pts[i+1];if(frac>=a.x&&frac<=b.x){const t=(frac-a.x)/Math.max(1e-6,b.x-a.x);return a.cents+(b.cents-a.cents)*t;}}return 0;
  }
  function drawPitchInsideNote(n,r){
    if(r.w<18)return;const has=(n.pitchPoints?.length||0)>0||n.vibratoDepth>0||n.slideFrom;if(!has)return;
    ctx.save();ctx.beginPath();ctx.rect(r.x+2,r.y+2,r.w-4,r.h-4);ctx.clip();ctx.strokeStyle='rgba(255,255,255,.72)';ctx.lineWidth=1;ctx.beginPath();
    for(let i=0;i<=Math.max(8,Math.floor(r.w/8));i++){const f=i/Math.max(8,Math.floor(r.w/8)),c=automationValue(n,f),y=r.y+r.h/2-clamp(c/600,-1,1)*(r.h*.36),x=r.x+f*r.w;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.stroke();ctx.restore();
  }
  function draw(){
    const w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.textBaseline='middle';ctx.font='11px ui-monospace, SFMono-Regular, Menlo, monospace';
    for(let m=MAX_MIDI;m>=MIN_MIDI;m--){const y=yForMidi(m);ctx.fillStyle=isBlack(m)?'#0d1217':'#141a20';ctx.fillRect(0,y,w,rowH());ctx.strokeStyle='#242c34';ctx.beginPath();ctx.moveTo(0,y+.5);ctx.lineTo(w,y+.5);ctx.stroke();ctx.fillStyle=isBlack(m)?'#0a0d11':'#e7ebef';ctx.fillRect(0,y,GUTTER,rowH());ctx.fillStyle=isBlack(m)?'#8995a1':'#28313a';ctx.textAlign='right';ctx.fillText(midiName(m),GUTTER-8,y+rowH()/2)}
    for(let b=0;b<=totalBeats()+1e-6;b+=Math.max(.125,snap())){const x=xForBeat(b),bar=Math.abs(b%4)<1e-6,beat=Math.abs(b-Math.round(b))<1e-6;ctx.strokeStyle=bar?'#5a6571':beat?'#36404a':'#222a31';ctx.lineWidth=bar?1.5:1;ctx.beginPath();ctx.moveTo(x+.5,0);ctx.lineTo(x+.5,h);ctx.stroke()}ctx.lineWidth=1;
    const settings=songSettings();if(settings.loop&&settings.loopEnd>settings.loopStart){ctx.fillStyle='rgba(255,157,66,.055)';ctx.fillRect(xForBeat(settings.loopStart),0,(settings.loopEnd-settings.loopStart)*pxBeat(),h);ctx.strokeStyle='rgba(255,157,66,.35)';ctx.strokeRect(xForBeat(settings.loopStart),0,(settings.loopEnd-settings.loopStart)*pxBeat(),h)}
    // slide connectors first
    for(const n of song.notes){if(!n.slideFrom)continue;const from=noteById(n.slideFrom);if(!from)continue;const a=noteRect(from),b=noteRect(n),x1=a.x+a.w,y1=a.y+a.h/2,x2=b.x,y2=b.y+b.h/2,dx=Math.max(18,(x2-x1)*.5);ctx.strokeStyle=trackColor(n.trackId);ctx.lineWidth=2;ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(x1,y1);ctx.bezierCurveTo(x1+dx,y1,x2-dx,y2,x2,y2);ctx.stroke();ctx.setLineDash([]);}
    for(const n of sortedNotes()){const r=noteRect(n),sel=song.selected.has(n.id),active=n.trackId===song.activeTrack,color=trackColor(n.trackId);ctx.globalAlpha=active?1:.72;ctx.fillStyle=sel?'#ff8a2d':color;ctx.strokeStyle=sel?'#ffe0c4':'rgba(255,255,255,.36)';ctx.lineWidth=sel?2:1;roundRect(ctx,r.x,r.y,r.w,r.h,5);ctx.fill();ctx.stroke();ctx.globalAlpha=1;ctx.fillStyle=sel?'#281507':'#071017';ctx.textAlign='left';ctx.font='700 11px ui-monospace, SFMono-Regular, Menlo, monospace';ctx.save();ctx.beginPath();ctx.rect(r.x+3,r.y,r.w-6,r.h);ctx.clip();ctx.fillText((n.lyric||'la')+' · '+midiName(n.midi),r.x+6,r.y+r.h/2);ctx.restore();drawPitchInsideNote(n,r);ctx.fillStyle=sel?'#fff0e3':'rgba(255,255,255,.65)';ctx.fillRect(r.x+r.w-4,r.y+3,2,r.h-6)}
    if(song.marquee){const m=song.marquee;ctx.fillStyle='rgba(95,166,214,.10)';ctx.strokeStyle='rgba(126,196,238,.8)';ctx.setLineDash([4,3]);ctx.fillRect(m.x,m.y,m.w,m.h);ctx.strokeRect(m.x,m.y,m.w,m.h);ctx.setLineDash([])}
    const cursor=song.playheadBeat!=null?song.playheadBeat:song.cursorBeat;if(cursor!=null){const x=xForBeat(cursor);ctx.strokeStyle=song.playheadBeat!=null?'#ffd36e':'#9ca8b5';ctx.lineWidth=song.playheadBeat!=null?2:1;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();ctx.lineWidth=1}
  }
  function point(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*(canvas.width/r.width),y:(e.clientY-r.top)*(canvas.height/r.height)}}
  function hitNote(x,y){for(const n of [...song.notes].reverse()){const r=noteRect(n);if(x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h)return{note:n,edge:x>r.x+r.w-11}}return null;}

  // ---------- canvas editing ----------
  function addNote(start,midi,duration=1,lyric='la'){
    const n=defaultNote(song.nextId++,clamp(q(start),0,Math.max(0,totalBeats()-snap())),clamp(Math.round(midi),MIN_MIDI,MAX_MIDI),Math.max(snap(),q(duration)),lyric);
    if(n.start+n.duration>totalBeats())n.duration=Math.max(snap(),totalBeats()-n.start);song.notes.push(n);selectOnly(n.id);return n;
  }
  canvas.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;canvas.setPointerCapture?.(e.pointerId);const p=point(e),hit=hitNote(p.x,p.y),beat=beatForX(p.x),midi=midiForY(p.y);if(p.x<GUTTER)return;
    if(song.tool==='eraser'){if(hit){remember();song.selected=new Set([hit.note.id]);song.primary=hit.note.id;deleteSelected()}return}
    if(song.tool==='slide'){
      if(!hit){song.slideSource=null;draw();return}
      if(!song.slideSource){song.slideSource=hit.note.id;selectOnly(hit.note.id);msg(`Slide source: ${hit.note.lyric||'la'} ${midiName(hit.note.midi)}. Click the target note.`)}
      else if(song.slideSource===hit.note.id){song.slideSource=null;msg('Slide source cleared.');draw()}
      else{remember();hit.note.slideFrom=song.slideSource;hit.note.slideBeats=Math.min(Math.max(snap(),hit.note.slideBeats||.35),Math.max(snap(),hit.note.duration));song.slideSource=null;selectOnly(hit.note.id);setDirty();msg('Slide connected. The target note now glides from the source pitch.')}return;
    }
    if(song.tool==='select'){
      if(hit){if(e.shiftKey)toggleSelect(hit.note.id);else if(!song.selected.has(hit.note.id))selectOnly(hit.note.id);remember();const ids=selectedNotes().map(n=>({id:n.id,start:n.start,midi:n.midi,duration:n.duration}));song.drag={mode:hit.edge&&song.selected.size===1?'resize':'move',id:hit.note.id,grabBeat:beat-hit.note.start,grabMidi:midi-hit.note.midi,items:ids,changed:false};}
      else{if(!e.shiftKey)selectOnly(null);song.marquee={x:p.x,y:p.y,w:0,h:0,startX:p.x,startY:p.y,append:e.shiftKey};song.drag={mode:'marquee'};}e.preventDefault();return;
    }
    // pencil: existing note = move/resize, empty = draw a new note
    if(hit){if(e.shiftKey)toggleSelect(hit.note.id);else selectOnly(hit.note.id);remember();song.drag={mode:hit.edge?'resize':'move',id:hit.note.id,grabBeat:beat-hit.note.start,grabMidi:midi-hit.note.midi,items:selectedNotes().map(n=>({id:n.id,start:n.start,midi:n.midi,duration:n.duration})),changed:false};}
    else{remember();const n=addNote(beat,midi,Math.max(1,snap()),'la');song.drag={mode:'draw',id:n.id,start:n.start,changed:true};setDirty();}
    e.preventDefault();
  });
  canvas.addEventListener('pointermove',e=>{
    if(!song.drag)return;const p=point(e),beat=beatForX(p.x),midi=midiForY(p.y);
    if(song.drag.mode==='marquee'){
      const m=song.marquee;m.x=Math.min(m.startX,p.x);m.y=Math.min(m.startY,p.y);m.w=Math.abs(p.x-m.startX);m.h=Math.abs(p.y-m.startY);const ids=noteRectsIn(m);if(m.append)ids.forEach(id=>song.selected.add(id));else song.selected=new Set(ids);song.primary=[...song.selected].at(-1)||null;updateInspector();draw();return;
    }
    const n=noteById(song.drag.id);if(!n)return;
    if(song.drag.mode==='draw'||song.drag.mode==='resize'){n.duration=clamp(Math.max(snap(),q(beat-n.start)),snap(),Math.max(snap(),totalBeats()-n.start));song.drag.changed=true;}
    else if(song.drag.mode==='move'){
      const anchor0=song.drag.items.find(x=>x.id===song.drag.id)||song.drag.items[0];const newStart=clamp(q(beat-song.drag.grabBeat),0,Math.max(0,totalBeats()-anchor0.duration)),newMidi=clamp(midi-song.drag.grabMidi,MIN_MIDI,MAX_MIDI),db=newStart-anchor0.start,dm=newMidi-anchor0.midi;
      for(const item of song.drag.items){const qn=noteById(item.id);if(!qn)continue;qn.start=clamp(q(item.start+db),0,Math.max(0,totalBeats()-qn.duration));qn.midi=clamp(item.midi+dm,MIN_MIDI,MAX_MIDI)}song.drag.changed=true;
    }
    updateInspector(false);setDirty();
  });
  function noteRectsIn(m){const out=[];for(const n of song.notes){const r=noteRect(n);if(r.x<m.x+m.w&&r.x+r.w>m.x&&r.y<m.y+m.h&&r.y+r.h>m.y)out.push(n.id)}return out;}
  function endPointer(){if(song.drag?.mode==='marquee')song.marquee=null;song.drag=null;draw();}
  canvas.addEventListener('pointerup',endPointer);canvas.addEventListener('pointercancel',endPointer);
  canvas.addEventListener('dblclick',e=>{const h=hitNote(point(e).x,point(e).y);if(h){selectOnly(h.note.id);$('songNoteLyric').focus();$('songNoteLyric').select();}});

  // ---------- tracks ----------
  function voiceOptionsHtml(selected){return app.voices.map(v=>`<option value="${esc(v.id)}" ${v.id===selected?'selected':''}>${esc((v.icon?v.icon+' ':'')+v.name+(v.temporary?' [browser]':''))}</option>`).join('')||'<option value="">No voices</option>'}
  function renderTracks(){
    ensureTrackVoices();const list=$('songTrackList');list.innerHTML='';for(const t of song.tracks){const row=document.createElement('div');row.className='daw-track-row'+(t.id===song.activeTrack?' active':'');row.dataset.trackId=t.id;
      row.innerHTML=`<button class="daw-track-select" title="Draw new notes on this track"><span class="daw-track-dot" style="background:${esc(t.color)}"></span><span>${esc(t.name)}</span></button><select class="daw-track-voice" data-act="voice" title="Singer for this track">${voiceOptionsHtml(t.voiceId)}</select><button class="mini-toggle ${t.mute?'active':''}" data-act="mute" title="Mute">M</button><button class="mini-toggle ${t.solo?'active':''}" data-act="solo" title="Solo">S</button><label class="daw-track-mini" title="Render-only track transpose"><span>TRN</span><input data-act="transpose" type="number" min="-24" max="24" step="1" value="${t.transpose||0}"></label><label class="daw-track-mini" title="Render-only timing offset in beats"><span>DLY</span><input data-act="delay" type="number" min="-8" max="8" step="0.125" value="${t.delayBeats||0}"></label><label class="mini-fader" title="Track gain"><span>VOL</span><input data-act="gain" type="range" min="-24" max="6" step="1" value="${t.gainDb}"></label><label class="mini-fader" title="Track pan"><span>PAN</span><input data-act="pan" type="range" min="-100" max="100" step="1" value="${t.pan}"></label>`;
      row.querySelector('.daw-track-select').onclick=()=>{song.activeTrack=t.id;renderTracks();populateVoices();draw();updateInspector(false)};
      row.querySelector('[data-act=voice]').onchange=e=>{remember();t.voiceId=e.target.value;setDirty();if(t.id===song.activeTrack)populateVoices();msg(`${t.name} singer: ${voiceById(t.voiceId)?.name||'missing voice'}.`)};
      row.querySelector('[data-act=mute]').onclick=()=>{remember();t.mute=!t.mute;renderTracks();setDirty()};row.querySelector('[data-act=solo]').onclick=()=>{remember();t.solo=!t.solo;renderTracks();setDirty()};
      row.querySelector('[data-act=transpose]').onchange=e=>{remember();t.transpose=clamp(Math.round(+e.target.value||0),-24,24);e.target.value=t.transpose;setDirty();msg(`${t.name} render transpose: ${t.transpose>0?'+':''}${t.transpose} st.`)};row.querySelector('[data-act=delay]').onchange=e=>{remember();t.delayBeats=clamp(+e.target.value||0,-8,8);e.target.value=trimNum(t.delayBeats);setDirty();msg(`${t.name} timing offset: ${t.delayBeats>0?'+':''}${trimNum(t.delayBeats)} beat.`)};
      row.querySelector('[data-act=gain]').oninput=e=>{t.gainDb=+e.target.value;setDirty()};row.querySelector('[data-act=pan]').oninput=e=>{t.pan=+e.target.value;setDirty()};list.appendChild(row)}
    $('songRemoveTrackBtn').disabled=song.tracks.length<=1;
    const sel=$('songNoteTrack');if(sel){const old=sel.value;sel.innerHTML='';for(const t of song.tracks){const o=document.createElement('option');o.value=t.id;o.textContent=t.name;sel.appendChild(o)}if(old)sel.value=old;}
  }
  function addTrack(){if(song.tracks.length>=8){msg('Eight vocal tracks is enough chaos for one browser tab 😭',true);return}remember();const id=song.nextTrackId++,t={id,name:`Vocal ${song.tracks.length+1}`,voiceId:trackById(song.activeTrack)?.voiceId||fallbackVoiceId(),gainDb:0,pan:0,transpose:0,delayBeats:0,mute:false,solo:false,color:TRACK_COLORS[(id-1)%TRACK_COLORS.length]};song.tracks.push(t);song.activeTrack=id;renderTracks();populateVoices();setDirty();}
  function duplicateTrack(){const src=trackById(song.activeTrack);if(!src)return;if(song.tracks.length>=8){msg('Eight vocal tracks is enough chaos for one browser tab 😭',true);return}remember();const id=song.nextTrackId++,copy={...src,id,name:(src.name+' copy').slice(0,40),mute:false,solo:false,color:TRACK_COLORS[(id-1)%TRACK_COLORS.length]},map=new Map(),created=[];song.tracks.push(copy);for(const n of song.notes.filter(n=>n.trackId===src.id)){const c=structuredClone(n);c.id=song.nextId++;c.trackId=id;map.set(n.id,c.id);created.push(c)}for(const c of created)c.slideFrom=map.get(c.slideFrom)||null;song.notes.push(...created);song.activeTrack=id;song.selected=new Set(created.map(n=>n.id));song.primary=created[0]?.id||null;renderTracks();populateVoices();updateInspector();setDirty();msg(`Duplicated ${src.name}${created.length?` with ${created.length} notes`:''}.`)}
  function removeTrack(){if(song.tracks.length<=1)return;const t=trackById(song.activeTrack);if(!t)return;const used=song.notes.filter(n=>n.trackId===t.id).length;if(used&&!confirm(`Delete “${t.name}” and its ${used} note${used===1?'':'s'}?`))return;remember();song.notes=song.notes.filter(n=>n.trackId!==t.id);song.tracks=song.tracks.filter(x=>x.id!==t.id);song.activeTrack=song.tracks[0].id;renderTracks();selectOnly(null);setDirty();}
  function renameTrack(){const t=trackById(song.activeTrack);if(!t)return;const name=prompt('Track name:',t.name);if(!name?.trim())return;remember();t.name=name.trim().slice(0,40);renderTracks();updateInspector(false);}

  // ---------- pronunciation / inspector ----------
  function parseOverride(text){const bad=[],phones=[];for(const raw of String(text||'').toUpperCase().split(/\s+/).filter(Boolean)){const code=raw.replace(/[012]$/,'');if(PHONE_CODES.has(code))phones.push({code,stress:+(raw.match(/[012]$/)?.[0]||0)});else bad.push(raw)}return{phones,bad};}
  function resolvedPhones(n){if(String(n.phones||'').trim()){const p=parseOverride(n.phones);return{detailed:p.phones,bad:p.bad,unknown:false}}const lyric=String(n.lyric||'la').trim()||'la';const r=app.wordPron(lyric);return{detailed:r.detailed||r.phones.map(code=>({code,stress:0})),bad:[],unknown:r.unknown};}
  function autoPhoneText(n){const r=resolvedPhones(n);return r.bad.length?'⚠ '+r.bad.join(' '):r.detailed.map(p=>p.code+(p.stress?String(p.stress):'')).join(' ');}
  function updateInspector(full=true){
    const n=noteById(song.primary),empty=$('songNoSelection'),panel=$('songNoteInspector');empty.hidden=!!n;panel.hidden=!n;$('songSelectionCount').textContent=song.selected.size?`${song.selected.size} selected`:'no selection';if(!n){drawPitchCurve();return}
    $('songSelectedPitch').textContent=midiName(n.midi);if(full){$('songNoteLyric').value=n.lyric||'';$('songNotePhones').value=n.phones||'';$('songNoteVelocity').value=n.velocity??100;$('songNoteTrack').value=String(n.trackId);$('songNoteFine').value=n.fineCents||0;$('songNoteSlideBeats').value=n.slideBeats??.35;$('songNoteSlideCurve').value=n.slideCurve||'smooth';$('songVibratoDepth').value=n.vibratoDepth||0;$('songVibratoRate').value=n.vibratoRate||5.5;$('songVibratoDelay').value=n.vibratoDelay??45;$('songVibratoFade').value=n.vibratoFade??20;}
    $('songNoteStart').value=trimNum(n.start);$('songNoteDuration').value=trimNum(n.duration);$('songNoteVelocityVal').textContent=Math.round(n.velocity??100)+'%';$('songNoteFineVal').textContent=(n.fineCents>0?'+':'')+Math.round(n.fineCents||0)+'¢';$('songNoteSlideVal').textContent=trimNum(n.slideBeats??.35)+' beat';$('songVibratoDepthVal').textContent=Math.round(n.vibratoDepth||0)+'¢';$('songVibratoRateVal').textContent=(+n.vibratoRate||5.5).toFixed(1)+' Hz';$('songVibratoDelayVal').textContent=Math.round(n.vibratoDelay??45)+'%';$('songVibratoFadeVal').textContent=Math.round(n.vibratoFade??20)+'%';
    $('songSlideStatus').textContent=n.slideFrom?`Linked from ${noteById(n.slideFrom)?(noteById(n.slideFrom).lyric||'la')+' '+midiName(noteById(n.slideFrom).midi):'missing source'}`:'No incoming slide';$('songUnlinkSlideBtn').disabled=!n.slideFrom;
    const r=resolvedPhones(n);$('songNoteAutoPhones').textContent=autoPhoneText(n);const vc=r.detailed.filter(p=>VOWELS.has(p.code)).length;$('songNoteHint').textContent=r.bad.length?'Fix the unknown ARPAbet codes above.':vc>1?'Multiple vowel nuclei detected. Splitting syllables across notes usually sings more clearly.':r.unknown?'Fallback pronunciation is being used; override ARPAbet if needed.':'Pronunciation ready.';drawPitchCurve();
  }
  function mutatePrimary(fn,{history=false}={}){const n=noteById(song.primary);if(!n)return;if(history)remember();fn(n);setDirty();updateInspector(false);}
  $('songNoteLyric').addEventListener('change',e=>mutatePrimary(n=>{n.lyric=e.target.value;n.phones='';$('songNotePhones').value='';},{history:true}));
  $('songNotePhones').addEventListener('change',e=>mutatePrimary(n=>{n.phones=e.target.value},{history:true}));
  $('songNoteStart').addEventListener('change',e=>mutatePrimary(n=>{n.start=clamp(q(+e.target.value||0),0,Math.max(0,totalBeats()-n.duration))},{history:true}));
  $('songNoteDuration').addEventListener('change',e=>mutatePrimary(n=>{n.duration=clamp(Math.max(snap(),q(+e.target.value||snap())),snap(),Math.max(snap(),totalBeats()-n.start));n.slideBeats=Math.min(n.slideBeats,n.duration)},{history:true}));
  $('songNoteVelocity').addEventListener('input',e=>mutatePrimary(n=>{n.velocity=+e.target.value||100}));
  $('songNoteVelocity').addEventListener('change',()=>remember());
  $('songNoteTrack').addEventListener('change',e=>mutatePrimary(n=>{n.trackId=+e.target.value||song.activeTrack},{history:true}));
  $('songNoteFine').addEventListener('input',e=>mutatePrimary(n=>{n.fineCents=+e.target.value||0}));
  $('songNoteSlideBeats').addEventListener('input',e=>mutatePrimary(n=>{n.slideBeats=clamp(+e.target.value||0,0,n.duration)}));
  $('songNoteSlideCurve').addEventListener('change',e=>mutatePrimary(n=>{n.slideCurve=e.target.value},{history:true}));
  $('songVibratoDepth').addEventListener('input',e=>mutatePrimary(n=>{n.vibratoDepth=+e.target.value||0}));
  $('songVibratoRate').addEventListener('input',e=>mutatePrimary(n=>{n.vibratoRate=+e.target.value||5.5}));
  $('songVibratoDelay').addEventListener('input',e=>mutatePrimary(n=>{n.vibratoDelay=+e.target.value||0}));
  $('songVibratoFade').addEventListener('input',e=>mutatePrimary(n=>{n.vibratoFade=+e.target.value||0}));
  $('songUnlinkSlideBtn').onclick=()=>mutatePrimary(n=>{n.slideFrom=null},{history:true});

  // ---------- per-note pitch automation canvas ----------
  function pitchPointXY(pt){const w=pitchCanvas.width,h=pitchCanvas.height;return{x:pt.x*w,y:h/2-(pt.cents/1200)*(h*.43)}}
  function pitchXYPoint(x,y){const w=pitchCanvas.width,h=pitchCanvas.height;return{x:clamp(x/w,0,1),cents:Math.round(clamp((h/2-y)/(h*.43)*1200,-1200,1200)/5)*5}}
  function drawPitchCurve(){if(!pitchCtx||!pitchCanvas)return;const n=noteById(song.primary),w=pitchCanvas.width,h=pitchCanvas.height;pitchCtx.clearRect(0,0,w,h);pitchCtx.fillStyle='#0d1217';pitchCtx.fillRect(0,0,w,h);pitchCtx.strokeStyle='#28323c';pitchCtx.lineWidth=1;for(const c of [-1200,-600,0,600,1200]){const y=h/2-(c/1200)*(h*.43);pitchCtx.beginPath();pitchCtx.moveTo(0,y+.5);pitchCtx.lineTo(w,y+.5);pitchCtx.stroke();pitchCtx.fillStyle='#73808c';pitchCtx.font='10px monospace';pitchCtx.fillText(c===0?'0':(c>0?'+':'')+c+'¢',6,y-4)}if(!n)return;const pts=[{x:0,cents:0},...(n.pitchPoints||[]).sort((a,b)=>a.x-b.x),{x:1,cents:0}];pitchCtx.strokeStyle='#ff9e42';pitchCtx.lineWidth=2;pitchCtx.beginPath();pts.forEach((p,i)=>{const v=pitchPointXY(p);if(i===0)pitchCtx.moveTo(v.x,v.y);else pitchCtx.lineTo(v.x,v.y)});pitchCtx.stroke();for(let i=1;i<pts.length-1;i++){const v=pitchPointXY(pts[i]);pitchCtx.fillStyle='#ffd1a8';pitchCtx.beginPath();pitchCtx.arc(v.x,v.y,5,0,Math.PI*2);pitchCtx.fill()} }
  function pitchCanvasPoint(e){const r=pitchCanvas.getBoundingClientRect();return{x:(e.clientX-r.left)*(pitchCanvas.width/r.width),y:(e.clientY-r.top)*(pitchCanvas.height/r.height)}}
  pitchCanvas?.addEventListener('pointerdown',e=>{const n=noteById(song.primary);if(!n)return;remember();const p=pitchCanvasPoint(e),pts=n.pitchPoints||(n.pitchPoints=[]);let idx=-1,best=14;pts.forEach((pt,i)=>{const v=pitchPointXY(pt),d=Math.hypot(v.x-p.x,v.y-p.y);if(d<best){best=d;idx=i}});if(e.button===2){if(idx>=0)pts.splice(idx,1);setDirty();updateInspector(false);e.preventDefault();return}if(idx<0){const np=pitchXYPoint(p.x,p.y);if(np.x>.015&&np.x<.985){pts.push(np);pts.sort((a,b)=>a.x-b.x);idx=pts.indexOf(np)}}song.pitchDrag={idx};pitchCanvas.setPointerCapture?.(e.pointerId);setDirty();});
  pitchCanvas?.addEventListener('pointermove',e=>{const n=noteById(song.primary);if(!n||!song.pitchDrag)return;const xy=pitchCanvasPoint(e),p=pitchXYPoint(xy.x,xy.y);const pt=n.pitchPoints[song.pitchDrag.idx];if(!pt)return;pt.x=clamp(p.x,.01,.99);pt.cents=p.cents;n.pitchPoints.sort((a,b)=>a.x-b.x);song.pitchDrag.idx=n.pitchPoints.indexOf(pt);setDirty();});
  const pitchEnd=()=>{song.pitchDrag=null};pitchCanvas?.addEventListener('pointerup',pitchEnd);pitchCanvas?.addEventListener('pointercancel',pitchEnd);pitchCanvas?.addEventListener('contextmenu',e=>e.preventDefault());
  $('songPitchResetBtn').onclick=()=>mutatePrimary(n=>{n.pitchPoints=[]},{history:true});

  // ---------- pitch model ----------
  function curveEase(t,type){t=clamp(t,0,1);if(type==='linear')return t;if(type==='fast')return 1-Math.pow(1-t,3);if(type==='late')return Math.pow(t,3);return t*t*(3-2*t);}
  function basePitchForNote(n,settings){const t=trackById(n.trackId);return n.midi-settings.baseMidi+settings.transpose+(t?.transpose||0)+(n.fineCents||0)/100;}
  function pitchAtBeat(n,beat,settings){
    const base=basePitchForNote(n,settings),frac=clamp((beat-n.start)/Math.max(.001,n.duration),0,1);let pitch=base+automationValue(n,frac)/100;
    if(n.slideFrom){const prev=noteById(n.slideFrom);if(prev){const slide=Math.max(.001,Math.min(n.slideBeats||.35,n.duration)),t=(beat-n.start)/slide;if(t<1){const from=basePitchForNote(prev,settings)+automationValue(prev,1)/100;pitch=from+(base-from)*curveEase(t,n.slideCurve||'smooth')+automationValue(n,frac)/100;}}}
    const depth=(n.vibratoDepth||0)/100;if(depth>0){const delay=clamp((n.vibratoDelay??45)/100,0,.95),start=n.start+n.duration*delay;if(beat>start){const fadeDur=Math.max(.001,n.duration*clamp((n.vibratoFade??20)/100,.01,1)),amp=clamp((beat-start)/fadeDur,0,1),secs=(beat-start)*60/settings.bpm;pitch+=Math.sin(secs*Math.PI*2*(n.vibratoRate||5.5))*depth*amp;}}
    return pitch;
  }
  function hasPitchMotion(n){return !!n.slideFrom||(n.vibratoDepth||0)>0||(n.pitchPoints?.some(p=>Math.abs(p.cents)>1));}

  // ---------- phoneme planning / duration ----------
  function phoneFixedDuration(code){if(STOPS.has(code))return .055;if(AFFRICATES.has(code))return .085;if(FRICATIVES.has(code))return .10;if(GLIDES.has(code))return .085;if(NASALS.has(code))return .09;return .075;}
  function sourceWindow(code,source){if(VOWELS.has(code))return Math.min(source.duration,DIPH.has(code) ? .95 : .82);if(NASALS.has(code))return Math.min(source.duration,.66);if(FRICATIVES.has(code))return Math.min(source.duration,.56);if(GLIDES.has(code))return Math.min(source.duration,.30);if(AFFRICATES.has(code))return Math.min(source.duration,.22);if(STOPS.has(code))return Math.min(source.duration,.17);return Math.min(source.duration,.34);}
  function sustainProfile(code,source,win){const d=Math.max(.03,Math.min(source.duration,win));if(DIPH.has(code))return{attackSeconds:Math.min(.085,d*.18),releaseSeconds:Math.min(.22,d*.38),crossfadeSeconds:.012};if(VOWELS.has(code))return{attackSeconds:Math.min(.075,d*.19),releaseSeconds:Math.min(.070,d*.18),crossfadeSeconds:.011};if(NASALS.has(code))return{attackSeconds:Math.min(.055,d*.17),releaseSeconds:Math.min(.050,d*.16),crossfadeSeconds:.009};if(FRICATIVES.has(code))return{attackSeconds:Math.min(.040,d*.14),releaseSeconds:Math.min(.040,d*.14),crossfadeSeconds:.008};return{attackSeconds:Math.min(.05,d*.18),releaseSeconds:Math.min(.05,d*.18),crossfadeSeconds:.009};}
  function hash01(id,salt=0){let x=((id+1)*0x9e3779b1^(song.variationSeed+salt)*0x85ebca6b)>>>0;x^=x>>>16;x=Math.imul(x,0x7feb352d);x^=x>>>15;x=Math.imul(x,0x846ca68b);x^=x>>>16;return(x>>>0)/4294967295;}
  function notePlan(n,settings,startOverride=null){
    const rp=resolvedPhones(n);if(rp.bad.length)throw new Error(`Note “${n.lyric||'la'}” has unknown ARPAbet: ${rp.bad.join(', ')}`);const phones=rp.detailed;if(!phones.length)return[];
    const beatSec=60/settings.bpm,human=settings.humanize,timingJitter=(hash01(n.id,1)*2-1)*.010*human,pitchJitter=(hash01(n.id,2)*2-1)*.08*human;
    const track=trackById(n.trackId),trackDelay=startOverride==null?(track?.delayBeats||0)*beatSec:0,startBeat=startOverride==null?n.start:0,noteStart=Math.max(0,(startOverride==null?n.start*beatSec:startOverride)+trackDelay+timingJitter),noteDur=Math.max(.06,n.duration*beatSec),noteEnd=noteStart+noteDur;
    const firstV=phones.findIndex(p=>VOWELS.has(p.code)),lastV=(()=>{let z=-1;phones.forEach((p,i)=>{if(VOWELS.has(p.code))z=i});return z})();const events=[],gainDb=20*Math.log10(Math.max(.05,(n.velocity??100)/100));
    const pitchAtSec=(sec)=>pitchAtBeat(n,n.start+(sec-noteStart)/beatSec,settings)+pitchJitter;
    if(firstV<0){const each=Math.max(.035,noteDur/phones.length);let cur=noteStart;for(const p of phones){events.push({code:p.code,start:cur,dur:each,pitch:UNVOICED.has(p.code)?0:pitchAtSec(cur+each/2),gainDb,note:n,trackId:n.trackId,dynamic:false});cur+=each}return events;}
    const leading=phones.slice(0,firstV),body=phones.slice(firstV),leadDesired=leading.reduce((a,p)=>a+phoneFixedDuration(p.code),0),preRoll=Math.min(leadDesired,settings.lead/1000),leadStart=Math.max(0,noteStart-preRoll);let cur=leadStart;
    for(const p of leading){const dur=phoneFixedDuration(p.code);events.push({code:p.code,start:cur,dur,pitch:UNVOICED.has(p.code)?0:pitchAtSec(noteStart),gainDb,note:n,trackId:n.trackId,dynamic:false});cur+=dur;}
    const bodyStart=Math.max(noteStart,cur-settings.legato/1000*.35),available=Math.max(.045,noteEnd-bodyStart),vowels=body.filter(p=>VOWELS.has(p.code));let fixed=body.filter(p=>!VOWELS.has(p.code)).reduce((a,p)=>a+phoneFixedDuration(p.code),0),fixedScale=fixed>available*.43?(available*.43/fixed):1;fixed*=fixedScale;const vowelSpace=Math.max(.025*vowels.length,available-fixed),weights=vowels.map(p=>(p.stress===1?1.22:p.stress===2?1.10:1)*(DIPH.has(p.code)?1.13:1)),sumW=weights.reduce((a,b)=>a+b,0)||1;let vi=0;cur=bodyStart;
    for(const p of body){const isV=VOWELS.has(p.code),dur=isV?vowelSpace*(weights[vi++]/sumW):phoneFixedDuration(p.code)*fixedScale,ov=Math.min(settings.legato/1000,isV?.035:.014,dur*.28),mid=cur+dur*.5,dynamic=!UNVOICED.has(p.code)&&DYNAMIC_PITCH_OK.has(p.code)&&hasPitchMotion(n)&&dur>=.085;events.push({code:p.code,start:cur,dur:Math.max(.025,dur),pitch:UNVOICED.has(p.code)?0:pitchAtSec(mid),pitchAt:dynamic?(local=>pitchAtSec(cur+local)):null,gainDb,note:n,trackId:n.trackId,dynamic});cur+=Math.max(.012,dur-ov);}
    if(lastV>=0&&events.length){const end=Math.max(...events.map(e=>e.start+e.dur));if(end>noteEnd+.08){const shift=end-(noteEnd+.08);for(let i=Math.max(0,events.length-(phones.length-lastV-1));i<events.length;i++)events[i].start=Math.max(noteStart,events[i].start-shift)}}return events;
  }

  // Apply a time-varying pitch curve to an already duration-correct phoneme.
  // We transform overlapping windows at local pitch values and overlap-add them.
  // The complete phoneme attack/release is never looped.
  function curvePitchBuffer(context,inputBuffer,pitchAt){
    const sr=context.sampleRate,data=inputBuffer.getChannelData(0),len=data.length;if(len<512)return inputBuffer;
    const frame=Math.min(len,Math.max(1024,Math.round(sr*.115))),hop=Math.max(256,Math.round(sr*.034)),out=new Float32Array(len),norm=new Float32Array(len),win=new Float32Array(frame);
    for(let i=0;i<frame;i++)win[i]=.5-.5*Math.cos(2*Math.PI*i/Math.max(1,frame-1));
    for(let start=-Math.floor(frame/2);start<len;start+=hop){const seg=new Float32Array(frame);for(let i=0;i<frame;i++){const src=start+i;if(src>=0&&src<len)seg[i]=data[src]}const midSec=clamp((start+frame/2)/sr,0,inputBuffer.duration),pitch=clamp(pitchAt(midSec),-24,24),shifted=MainVoiceDSP.transform(seg,sr,sr,{pitchSemitones:pitch,speed:1});for(let i=0;i<frame;i++){const dst=start+i;if(dst<0||dst>=len)continue;const w=win[i];out[dst]+=(shifted[i]||0)*w;norm[dst]+=w}}
    for(let i=0;i<len;i++){if(norm[i]>1e-5)out[i]/=norm[i];else out[i]=data[i]}const b=context.createBuffer(1,len,sr);b.copyToChannel(out,0);return b;
  }

  async function renderSong(onlyNote=null){
    if(!app.voices?.length)throw new Error('Install or browser-load at least one MainVoice first.');ensureTrackVoices();
    const settings=songSettings(),notes=onlyNote?[{...onlyNote,start:0,trackId:onlyNote.trackId||song.activeTrack}]:sortedNotes();if(!notes.length)throw new Error('Draw at least one note first.');
    const soloed=song.tracks.filter(t=>t.solo).map(t=>t.id),audibleTrack=t=>!t.mute&&(!soloed.length||soloed.includes(t.id));const plans=[],neededTracks=new Set();for(const n of notes){const t=trackById(n.trackId);if(onlyNote||(t&&audibleTrack(t))){plans.push(...notePlan(n,settings,onlyNote?.08:null));neededTracks.add(n.trackId)}}
    const trackSources=new Map();for(const trackId of neededTracks){const t=trackById(trackId),voice=voiceById(t?.voiceId)||app.voice||app.voices[0];if(!voice)throw new Error(`Track ${t?.name||trackId} has no singer.`);const buffers=app.getVoiceBuffers?await app.getVoiceBuffers(voice):(voice.id===app.voice?.id?app.buffers:null);if(!buffers?.size)throw new Error(`${voice.name} has no decoded phoneme samples.`);trackSources.set(trackId,{voice,buffers})}
    const missingByVoice=new Map();for(const e of plans){const src=trackSources.get(e.trackId);if(src&&!src.buffers.has(e.code)){if(!missingByVoice.has(src.voice.name))missingByVoice.set(src.voice.name,new Set());missingByVoice.get(src.voice.name).add(e.code)}}if(missingByVoice.size)throw new Error([...missingByVoice].map(([name,codes])=>`${name} is missing ${[...codes].join(', ')}`).join(' · '));
    const sr=48000,temp=new OfflineAudioContext(1,sr,sr),cache=new Map(),renderEvents=[];
    for(const e of plans){const vs=trackSources.get(e.trackId),source=vs.buffers.get(e.code),win=sourceWindow(e.code,source),target=Math.max(.018,e.dur),natural=Math.min(source.duration,win),useSustain=SUSTAINABLE.has(e.code)&&target>natural*1.04;
      if(e.dynamic){let base;if(useSustain){const prof=sustainProfile(e.code,source,win);base=MainVoiceDSP.sustainToAudioBuffer(temp,source,{pitchSemitones:0,targetSeconds:target,maxSourceSeconds:win,...prof});}else{base=MainVoiceDSP.toAudioBuffer(temp,source,{pitchSemitones:0,speed:clamp(win/target,.08,8),maxSourceSeconds:win});}renderEvents.push({...e,voiceId:vs.voice.id,buffer:curvePitchBuffer(temp,base,e.pitchAt)});continue;}
      const pitchQ=Math.round(e.pitch*20)/20,durQ=Math.round(target*1000)/1000,key=`${vs.voice.id}|${e.code}|${pitchQ}|${durQ}|${useSustain?'hold':'short'}`;let buf=cache.get(key);if(!buf){if(useSustain){const prof=sustainProfile(e.code,source,win);buf=MainVoiceDSP.sustainToAudioBuffer(temp,source,{pitchSemitones:pitchQ,targetSeconds:target,maxSourceSeconds:win,...prof});}else{buf=MainVoiceDSP.toAudioBuffer(temp,source,{pitchSemitones:pitchQ,speed:clamp(win/target,.08,8),maxSourceSeconds:win});}cache.set(key,buf)}renderEvents.push({...e,voiceId:vs.voice.id,buffer:buf});
    }
    let end=Math.max(.2,...renderEvents.map(e=>e.start+e.buffer.duration));if(song.backing.buffer&&!song.backing.mute){const off=song.backing.offsetBeats*secPerBeat();end=Math.max(end,Math.max(0,off)+song.backing.buffer.duration)}end+=.22;
    const length=Math.ceil(end*sr),off=new OfflineAudioContext(2,length,sr),master=off.createGain(),comp=off.createDynamicsCompressor();master.gain.value=dbGain(settings.gainDb);comp.threshold.value=-6;comp.knee.value=8;comp.ratio.value=3;comp.attack.value=.004;comp.release.value=.14;master.connect(comp);comp.connect(off.destination);
    const buses=new Map();for(const t of song.tracks){const g=off.createGain();g.gain.value=dbGain(t.gainDb||0);let dest=g;if(typeof off.createStereoPanner==='function'){const p=off.createStereoPanner();p.pan.value=clamp((t.pan||0)/100,-1,1);g.connect(p);p.connect(master);dest=g}else g.connect(master);buses.set(t.id,dest)}
    for(const e of renderEvents){const s=off.createBufferSource(),g=off.createGain(),start=Math.max(0,e.start);s.buffer=e.buffer;s.connect(g);g.connect(buses.get(e.trackId)||master);const peak=dbGain(e.gainDb),dur=e.buffer.duration,fade=Math.min(.012,Math.max(.0025,settings.legato/1000*.35),dur*.20);g.gain.setValueAtTime(0,start);g.gain.linearRampToValueAtTime(peak,start+fade);g.gain.setValueAtTime(peak,Math.max(start+fade,start+dur-fade));g.gain.linearRampToValueAtTime(0,start+dur);s.start(start)}
    if(song.backing.buffer&&!song.backing.mute){const s=off.createBufferSource(),g=off.createGain(),offsetSec=song.backing.offsetBeats*secPerBeat();s.buffer=song.backing.buffer;g.gain.value=dbGain(song.backing.gainDb||0);s.connect(g);g.connect(master);if(offsetSec>=0)s.start(offsetSec);else s.start(0,Math.min(song.backing.buffer.duration,-offsetSec));}
    return off.startRendering();
  }

  // ---------- transport ----------
  function stopSong(){if(song.source){try{song.source.stop()}catch{}song.source=null}cancelAnimationFrame(song.playRaf);song.playRaf=0;song.playheadBeat=null;draw();app.setStatus?.('song stopped');}
  function animatePlayhead(){if(!song.source)return;const s=songSettings(),elapsed=(performance.now()-song.playStartMs)/1000;let beat=song.playStartBeat+elapsed/secPerBeat();if(s.loop&&s.loopEnd>s.loopStart&&beat>=s.loopEnd)beat=s.loopStart+((beat-s.loopStart)%(s.loopEnd-s.loopStart));song.playheadBeat=beat;if(!s.loop&&beat>totalBeats()+.5){stopSong();return}if($('songFollowPlayhead')?.checked){const vp=$('songRollViewport'),x=xForBeat(beat),left=vp.scrollLeft,right=left+vp.clientWidth;if(x<left+GUTTER+40||x>right-80){vp.scrollLeft=Math.max(0,x-vp.clientWidth*.42);syncRuler()}}draw();song.playRaf=requestAnimationFrame(animatePlayhead);}
  async function playBuffer(buf,withPlayhead=false){stopSong();app.stopSpeech?.();const ac=app.getAudioCtx(),s=ac.createBufferSource();s.buffer=buf;s.connect(ac.destination);const settings=songSettings(),offset=clamp(song.cursorBeat*secPerBeat(),0,Math.max(0,buf.duration-.01));if(withPlayhead&&settings.loop&&settings.loopEnd>settings.loopStart){s.loop=true;s.loopStart=settings.loopStart*secPerBeat();s.loopEnd=Math.min(buf.duration,settings.loopEnd*secPerBeat())}s.start(0,offset);song.source=s;if(withPlayhead){song.playStartBeat=song.cursorBeat;song.playStartMs=performance.now();animatePlayhead()}s.onended=()=>{if(song.source===s){song.source=null;cancelAnimationFrame(song.playRaf);song.playRaf=0;song.playheadBeat=null;draw();}};}
  async function playSong(){try{msg('Rendering vocal DAW mix…');app.setStatus?.('rendering song','busy');$('songPlayBtn').disabled=true;const b=await renderSong();song.rendered=b;await playBuffer(b,true);msg(`Playing ${song.notes.length} notes across ${song.tracks.length} vocal track${song.tracks.length===1?'':'s'}.`);app.setStatus?.('playing song');}catch(e){console.error(e);msg(e.message,true);app.setStatus?.('song render failed','bad')}finally{$('songPlayBtn').disabled=false}}
  async function auditionSelected(){const n=noteById(song.primary);if(!n)return;try{msg(`Rendering ${n.lyric||'la'} on ${midiName(n.midi)}…`);const b=await renderSong(n);const old=song.cursorBeat;song.cursorBeat=0;await playBuffer(b,false);song.cursorBeat=old;msg(`Audition: ${n.lyric||'la'} · ${midiName(n.midi)}`)}catch(e){msg(e.message,true)}}
  function encodeStereoWav(buf){const channels=Math.min(2,buf.numberOfChannels),L=buf.getChannelData(0),R=channels>1?buf.getChannelData(1):L,frames=L.length,ab=new ArrayBuffer(44+frames*4),dv=new DataView(ab),put=(o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i))};put(0,'RIFF');dv.setUint32(4,36+frames*4,true);put(8,'WAVE');put(12,'fmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,2,true);dv.setUint32(24,buf.sampleRate,true);dv.setUint32(28,buf.sampleRate*4,true);dv.setUint16(32,4,true);dv.setUint16(34,16,true);put(36,'data');dv.setUint32(40,frames*4,true);let o=44;for(let i=0;i<frames;i++){for(const s0 of [L[i],R[i]]){const s=clamp(s0,-1,1);dv.setInt16(o,s<0?s*32768:s*32767,true);o+=2}}return ab;}
  async function exportSong(){try{msg('Rendering stereo WAV…');app.setStatus?.('rendering song WAV','busy');const b=await renderSong();song.rendered=b;const safe=String($('songTitle').value||'mainvoice-song').trim().replace(/[^a-z0-9_-]+/gi,'-').replace(/^-+|-+$/g,'')||'mainvoice-song';app.download(new Blob([encodeStereoWav(b)],{type:'audio/wav'}),safe+'.wav');msg('Stereo song WAV exported.');app.setStatus?.('song WAV exported')}catch(e){msg(e.message,true);app.setStatus?.('song export failed','bad')}}

  // ---------- backing track ----------
  async function loadBacking(file){if(!file)return;try{msg('Decoding backing track…');const ab=await file.arrayBuffer(),buf=await app.getAudioCtx().decodeAudioData(ab.slice(0));song.backing.buffer=buf;song.backing.name=file.name;$('songBackingName').textContent=`${file.name} · ${buf.duration.toFixed(1)} s`;$('songBackingRemove').disabled=false;setDirty();msg('Backing track loaded locally. It will be included in playback/export, but not embedded in song JSON.')}catch(e){msg('Could not decode backing track: '+e.message,true)}finally{$('songBackingInput').value=''}}
  function clearBacking(){song.backing.buffer=null;song.backing.name='';$('songBackingName').textContent='No backing track loaded';$('songBackingRemove').disabled=true;setDirty();}

  // ---------- project save/load ----------
  function projectObject(){const s=songSettings();return{format:'mainvoice-song-4',title:$('songTitle').value||'Untitled MainVoice Song',voiceHint:trackById(song.activeTrack)?.voiceId||app.voice?.id||'',bpm:s.bpm,bars:+$('songBars').value||8,snap:snap(),baseMidi:s.baseMidi,transpose:s.transpose,legatoMs:s.legato,consonantLeadMs:s.lead,gainDb:s.gainDb,humanize:Math.round(s.humanize*100),zoomX:pxBeat(),zoomY:rowH(),loop:s.loop,loopStart:s.loopStart,loopEnd:s.loopEnd,followPlayhead:!!$('songFollowPlayhead')?.checked,tracks:song.tracks.map(t=>({...t})),activeTrack:song.activeTrack,notes:sortedNotes().map(n=>({...n})),backing:{name:song.backing.name,gainDb:song.backing.gainDb,offsetBeats:song.backing.offsetBeats,mute:song.backing.mute}};}
  function normalizeLoadedNote(n,i){const base=defaultNote(+n.id||i+1,Math.max(0,+n.start||0),clamp(Math.round(+n.midi||60),MIN_MIDI,MAX_MIDI),Math.max(.125,+n.duration||1),String(n.lyric||'la'));return{...base,...n,id:+n.id||i+1,trackId:+n.trackId||1,pitchPoints:Array.isArray(n.pitchPoints)?n.pitchPoints.map(p=>({x:clamp(+p.x||0,0,1),cents:clamp(+p.cents||0,-1200,1200)})):[]};}
  async function applyProjectObject(p,sourceName=''){if(!['mainvoice-song-1','mainvoice-song-2','mainvoice-song-3','mainvoice-song-4'].includes(p.format))throw new Error('That is not a supported MainVoice song project.');stopSong();$('songTitle').value=p.title||'Untitled MainVoice Song';$('songBpm').value=clamp(+p.bpm||120,30,300);$('songBars').value=[4,8,16,32,64].includes(+p.bars)?+p.bars:8;$('songSnap').value=String([1,.5,.25,.125,0].includes(+p.snap)?+p.snap:.25);$('songBaseNote').value=String(clamp(+p.baseMidi||60,MIN_MIDI,MAX_MIDI));$('songTranspose').value=String(clamp(+p.transpose||0,-24,24));$('songLegato').value=clamp(+p.legatoMs||18,0,100);$('songLead').value=clamp(+p.consonantLeadMs||45,0,180);$('songGain').value=clamp(+p.gainDb||0,-18,6);$('songHumanize').value=clamp(+p.humanize||0,0,100);$('songZoomX').value=clamp(+p.zoomX||82,42,150);$('songZoomY').value=clamp(+p.zoomY||24,18,34);$('songLoop').checked=!!p.loop;$('songLoopStart').value=+p.loopStart||0;$('songLoopEnd').value=+p.loopEnd||Math.min(8,totalBeats());if($('songFollowPlayhead'))$('songFollowPlayhead').checked=p.followPlayhead!==false;const legacyVoice=app.voices.some(v=>v.id===p.voiceHint)?p.voiceHint:fallbackVoiceId();song.tracks=Array.isArray(p.tracks)&&p.tracks.length?p.tracks.map((t,i)=>({id:+t.id||i+1,name:String(t.name||`Vocal ${i+1}`),voiceId:String(t.voiceId||legacyVoice),gainDb:clamp(+t.gainDb||0,-24,6),pan:clamp(+t.pan||0,-100,100),transpose:clamp(Math.round(+t.transpose||0),-24,24),delayBeats:clamp(+t.delayBeats||0,-8,8),mute:!!t.mute,solo:!!t.solo,color:t.color||TRACK_COLORS[i%TRACK_COLORS.length]})):[{...defaultTrack(),voiceId:legacyVoice}];ensureTrackVoices();song.activeTrack=+p.activeTrack||song.tracks[0].id;song.notes=(Array.isArray(p.notes)?p.notes:[]).map(normalizeLoadedNote);song.nextId=Math.max(0,...song.notes.map(n=>n.id))+1;song.nextTrackId=Math.max(1,...song.tracks.map(t=>t.id))+1;song.selected=new Set(song.notes[0]?[song.notes[0].id]:[]);song.primary=song.notes[0]?.id||null;song.backing={buffer:null,name:p.backing?.name||'',gainDb:+p.backing?.gainDb||-8,offsetBeats:+p.backing?.offsetBeats||0,mute:!!p.backing?.mute};$('songBackingGain').value=song.backing.gainDb;$('songBackingOffset').value=song.backing.offsetBeats;$('songBackingMute').checked=song.backing.mute;$('songBackingName').textContent=song.backing.name?`${song.backing.name} (reattach audio file)`:'No backing track loaded';$('songBackingRemove').disabled=true;refreshControlOutputs();renderTracks();resizeCanvas();updateInspector();setDirty();populateVoices();song.undo=[];song.redo=[];updateUndoButtons();msg(`Loaded ${song.notes.length} notes${sourceName?' from '+sourceName:''}.${song.backing.name?' Reattach the backing track audio file.':''}`)}
  async function loadProjectFile(f){try{const p=JSON.parse(await f.text());await applyProjectObject(p,f.name)}catch(err){msg(err.message,true)}}
  async function restoreSongAutosave(){try{const raw=localStorage.getItem(SONG_AUTOSAVE_KEY);if(!raw){msg('No song autosave exists yet.',true);return}await applyProjectObject(JSON.parse(raw),'browser autosave');msg('Restored the latest local song autosave.')}catch(e){msg('Could not restore autosave: '+e.message,true)}}
  function clearSongAutosave(){try{localStorage.removeItem(SONG_AUTOSAVE_KEY)}catch{}setAutosaveStatus('Autosave cleared. New edits will create a fresh draft.');msg('Song autosave cleared.')}

  // ---------- batch / utilities ----------
  function applyLyrics(){const parts=String($('songLyricsBatch').value||'').trim().split(/\s+/).filter(Boolean),notes=sortedNotes();if(!parts.length||!notes.length){msg('Add notes and type lyrics first.',true);return}remember();notes.forEach((n,i)=>{if(parts[i]!=null){n.lyric=parts[i];n.phones=''}});updateInspector();setDirty();msg(`Applied ${Math.min(parts.length,notes.length)} lyric token${Math.min(parts.length,notes.length)===1?'':'s'}.`);}
  function quantizeSelected(){const sel=selectedNotes();if(!sel.length)return;remember();for(const n of sel){n.start=clamp(q(n.start),0,totalBeats()-snap());n.duration=Math.max(snap(),q(n.duration))}updateInspector();setDirty();msg('Quantized selected notes.');}
  function transposeSelected(st){const sel=selectedNotes();if(!sel.length)return;remember();for(const n of sel)n.midi=clamp(n.midi+st,MIN_MIDI,MAX_MIDI);updateInspector();setDirty();}
  function autoSlides(){const groups=new Map();for(const n of sortedNotes()){if(!groups.has(n.trackId))groups.set(n.trackId,[]);groups.get(n.trackId).push(n)}let count=0;remember();for(const notes of groups.values()){for(let i=1;i<notes.length;i++){const a=notes[i-1],b=notes[i],gap=b.start-(a.start+a.duration);if(Math.abs(gap)<=Math.max(.02,snap()*.15)&&a.midi!==b.midi){b.slideFrom=a.id;b.slideBeats=Math.min(Math.max(snap(),.25),b.duration);count++}}}setDirty();updateInspector();msg(`Connected ${count} touching pitch change${count===1?'':'s'} with slides.`);}
  function demo(){remember();song.tracks=[defaultTrack(),{id:2,name:'Harmony',voiceId:app.voices[1]?.id||fallbackVoiceId(),gainDb:-5,pan:24,transpose:0,delayBeats:0,mute:false,solo:false,color:TRACK_COLORS[1]}];song.nextTrackId=3;song.notes=[];song.nextId=1;const melody=[[60,0,1,'main'],[62,1,1,'voice'],[64,2,1,'can'],[67,3,2,'sing'],[65,5,1,'and'],[64,6,1,'slide'],[62,7,2,'now']];for(const [m,s,d,l] of melody){const n=defaultNote(song.nextId++,s,m,d,l);n.trackId=1;if(l==='sing'){n.vibratoDepth=45;n.vibratoDelay=42}song.notes.push(n)}for(let i=1;i<song.notes.length;i++){if(i===1||i===3||i===5){song.notes[i].slideFrom=song.notes[i-1].id;song.notes[i].slideBeats=.35}}const harm=[[55,0,2,'ooh'],[57,2,2,'ooh'],[60,4,2,'ooh'],[59,6,3,'ooh']];for(const [m,s,d,l] of harm){const n=defaultNote(song.nextId++,s,m,d,l);n.trackId=2;n.vibratoDepth=25;n.vibratoDelay=55;song.notes.push(n)}song.activeTrack=1;song.selected=new Set([song.notes[0].id]);song.primary=song.notes[0].id;$('songBars').value='4';renderTracks();resizeCanvas();updateInspector();setDirty();msg('Loaded a two-layer demo with slides and vibrato.');}
  function clearNotes(){if(song.notes.length&&!confirm('Clear every vocal note? Tracks and backing audio will stay.'))return;remember();stopSong();song.notes=[];song.selected.clear();song.primary=null;updateInspector();setDirty();msg('Vocal notes cleared.');}
  function selectAllNotes(){song.selected=new Set(song.notes.map(n=>n.id));song.primary=song.notes[0]?.id||null;updateInspector();draw();msg(`Selected ${song.notes.length} note${song.notes.length===1?'':'s'}.`)}
  function fitNotes(){if(!song.notes.length){msg('Add some notes first.',true);return}const notes=sortedNotes(),minBeat=Math.max(0,Math.min(...notes.map(n=>n.start))-.5),maxBeat=Math.min(totalBeats(),Math.max(...notes.map(n=>n.start+n.duration))+.5),minMidi=Math.max(MIN_MIDI,Math.min(...notes.map(n=>n.midi))-2),maxMidi=Math.min(MAX_MIDI,Math.max(...notes.map(n=>n.midi))+2),vp=$('songRollViewport'),usableW=Math.max(360,vp.clientWidth-GUTTER-24),span=Math.max(1,maxBeat-minBeat),zoom=clamp(usableW/span,42,150),usableH=Math.max(300,vp.clientHeight-24),rows=Math.max(4,maxMidi-minMidi+1),zy=clamp(usableH/rows,18,34);$('songZoomX').value=zoom;$('songZoomY').value=zy;refreshControlOutputs();resizeCanvas();vp.scrollLeft=Math.max(0,xForBeat(minBeat)-GUTTER);vp.scrollTop=Math.max(0,yForMidi(maxMidi)-rowH());draw();scheduleAutosave();msg('Fit the piano roll around the current notes.')}

  // ---------- UI binding ----------
  function populateNoteSelectors(){const base=$('songBaseNote');base.innerHTML='';for(let m=MIN_MIDI;m<=MAX_MIDI;m++){const o=document.createElement('option');o.value=m;o.textContent=midiName(m);if(m===60)o.selected=true;base.appendChild(o)}const tr=$('songTranspose');tr.innerHTML='';for(let n=-24;n<=24;n++){const o=document.createElement('option');o.value=n;o.textContent=(n>0?'+':'')+n+' st';if(n===0)o.selected=true;tr.appendChild(o)}}
  function populateVoices(){ensureTrackVoices();const sel=$('songVoiceSelect'),voices=app.voices||[],active=trackById(song.activeTrack);sel.innerHTML='';if(!voices.length){sel.innerHTML='<option value="">No voice loaded yet</option>';return}for(const v of voices){const o=document.createElement('option');o.value=v.id;o.textContent=(v.icon?v.icon+' ':'')+v.name+(v.temporary?' [browser test]':'');o.selected=(active?.voiceId||fallbackVoiceId())===v.id;sel.appendChild(o)}}
  function refreshControlOutputs(){
    $('songLegatoVal').textContent=Math.round(+$('songLegato').value)+' ms';$('songLeadVal').textContent=Math.round(+$('songLead').value)+' ms';$('songGainVal').textContent=((+$('songGain').value)>0?'+':'')+Math.round(+$('songGain').value)+' dB';$('songHumanizeVal').textContent=Math.round(+$('songHumanize').value)+'%';$('songZoomXVal').textContent=Math.round(pxBeat())+' px/beat';$('songZoomYVal').textContent=Math.round(rowH())+' px/key';$('songBackingGainVal').textContent=((+$('songBackingGain').value)>0?'+':'')+Math.round(+$('songBackingGain').value)+' dB';song.rendered=null;
  }
  function setCursor(b){song.cursorBeat=clamp(b,0,totalBeats());$('songCursorVal').textContent=`beat ${trimNum(song.cursorBeat)}`;draw();}

  $('songPlayBtn').onclick=playSong;$('songStopBtn').onclick=stopSong;$('songExportBtn').onclick=exportSong;$('songNoteAuditionBtn').onclick=auditionSelected;$('songUndoBtn').onclick=undo;$('songRedoBtn').onclick=redo;
  $('songNoteDuplicateBtn').onclick=duplicateSelected;$('songNoteDeleteBtn').onclick=deleteSelected;$('songCopyBtn').onclick=copySelected;$('songPasteBtn').onclick=pasteClipboard;$('songSelectAllBtn').onclick=selectAllNotes;$('songDuplicateToolbarBtn').onclick=duplicateSelected;$('songFitBtn').onclick=fitNotes;$('songQuantizeBtn').onclick=quantizeSelected;$('songOctaveUpBtn').onclick=()=>transposeSelected(12);$('songOctaveDownBtn').onclick=()=>transposeSelected(-12);$('songSemiUpBtn').onclick=()=>transposeSelected(1);$('songSemiDownBtn').onclick=()=>transposeSelected(-1);$('songAutoSlidesBtn').onclick=autoSlides;
  $('songApplyLyricsBtn').onclick=applyLyrics;$('songDemoBtn').onclick=demo;$('songClearBtn').onclick=clearNotes;
  $('songAddTrackBtn').onclick=addTrack;$('songDuplicateTrackBtn').onclick=duplicateTrack;$('songRemoveTrackBtn').onclick=removeTrack;$('songRenameTrackBtn').onclick=renameTrack;
  $('songSaveBtn').onclick=()=>{const p=projectObject(),name=String(p.title).trim().replace(/[^a-z0-9_-]+/gi,'-')||'mainvoice-song';app.download(new Blob([JSON.stringify(p,null,2)],{type:'application/json'}),name+'.mainvoice-song.json');msg('Song project saved. Backing audio is referenced by name only, not embedded.')};
  $('songLoadInput').onchange=async e=>{const f=e.target.files?.[0];if(f)await loadProjectFile(f);e.target.value=''};$('songRestoreDraftBtn').onclick=restoreSongAutosave;$('songClearDraftBtn').onclick=clearSongAutosave;$('songTitle').addEventListener('input',scheduleAutosave);
  $('songBackingInput').onchange=e=>loadBacking(e.target.files?.[0]);$('songBackingRemove').onclick=clearBacking;$('songBackingGain').oninput=e=>{song.backing.gainDb=+e.target.value;refreshControlOutputs();setDirty()};$('songBackingOffset').onchange=e=>{song.backing.offsetBeats=+e.target.value||0;setDirty()};$('songBackingMute').onchange=e=>{song.backing.mute=e.target.checked;setDirty()};
  $('songVoiceSelect').onchange=e=>{const t=trackById(song.activeTrack);if(!t)return;remember();t.voiceId=e.target.value;renderTracks();setDirty();msg(`${t.name} singer: ${voiceById(t.voiceId)?.name||'missing voice'}.`)};document.addEventListener('mainvoice:voiceschange',()=>{ensureTrackVoices();populateVoices();renderTracks();setDirty()});document.addEventListener('mainvoice:voicechange',()=>{ensureTrackVoices();populateVoices();renderTracks()});
  document.querySelectorAll('[data-song-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.songTool));
  for(const id of ['songLegato','songLead','songGain','songHumanize','songZoomX','songZoomY'])$(id).addEventListener('input',()=>{refreshControlOutputs();if(id==='songZoomX'||id==='songZoomY')resizeCanvas();else setDirty()});
  for(const id of ['songBpm','songSnap','songBaseNote','songTranspose'])$(id).addEventListener('change',()=>{refreshControlOutputs();resizeCanvas();updateInspector(false);setDirty()});
  $('songBars').addEventListener('change',()=>{const max=totalBeats();for(const n of song.notes){n.start=clamp(n.start,0,Math.max(0,max-snap()));n.duration=Math.max(snap(),Math.min(n.duration,max-n.start))}$('songLoopEnd').value=Math.min(+$('songLoopEnd').value||max,max);resizeCanvas();updateInspector(false);setDirty()});
  for(const id of ['songLoop','songLoopStart','songLoopEnd','songFollowPlayhead'])$(id).addEventListener('change',()=>{const s=songSettings();if(s.loopEnd<=s.loopStart)$('songLoopEnd').value=Math.min(totalBeats(),s.loopStart+4);draw();scheduleAutosave()});
  $('songRollViewport').addEventListener('scroll',syncRuler);
  $('songRuler').addEventListener('pointerdown',e=>{const vp=$('songRollViewport'),r=$('songRuler').getBoundingClientRect(),x=e.clientX-r.left+vp.scrollLeft;setCursor(q(beatForX(x)))});
  $('songRewindBtn').onclick=()=>setCursor(0);

  document.addEventListener('keydown',e=>{
    const edit=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName),mod=e.ctrlKey||e.metaKey;
    if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();return}if(mod&&e.key.toLowerCase()==='y'){e.preventDefault();redo();return}if(mod&&e.key.toLowerCase()==='c'&&!edit){e.preventDefault();copySelected();return}if(mod&&e.key.toLowerCase()==='v'&&!edit){e.preventDefault();pasteClipboard();return}if(mod&&e.key.toLowerCase()==='a'&&!edit){e.preventDefault();selectAllNotes();return}if(mod&&e.key.toLowerCase()==='d'&&!edit){e.preventDefault();duplicateSelected();return}
    if(edit)return;if(e.code==='Space'){e.preventDefault();song.source?stopSong():playSong();return}if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteSelected();return}if(e.key==='1')setTool('select');if(e.key==='2')setTool('pencil');if(e.key==='3')setTool('eraser');if(e.key==='4')setTool('slide');if(e.key==='ArrowUp'){e.preventDefault();transposeSelected(e.shiftKey?12:1)}if(e.key==='ArrowDown'){e.preventDefault();transposeSelected(e.shiftKey?-12:-1)}
  });

  // ---------- init ----------
  song.tracks=[defaultTrack()];populateNoteSelectors();populateVoices();renderTracks();refreshControlOutputs();setTool('pencil');resizeCanvas();updateInspector();updateUndoButtons();setCursor(0);$('songBackingGain').value=song.backing.gainDb;$('songBackingGainVal').textContent='-8 dB';song.autosaveReady=true;try{const a=JSON.parse(localStorage.getItem(SONG_AUTOSAVE_KEY)||'null');if(a?._autosavedAt)setAutosaveStatus('Autosave available · '+new Date(a._autosavedAt).toLocaleString())}catch{}
})();
