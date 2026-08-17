/* MainVoice Conversation Studio — multi-voice dialogue composer + renderer.
   Source-only feature: uses the existing MainVoiceApp, MainVoiceDSP, bundled
   pronunciation dictionary, and installed/browser-loaded voice metadata. */
(() => {
  'use strict';
  const app = window.MainVoiceApp;
  if (!app) return;
  const $ = id => document.getElementById(id);
  const root = $('convTimeline');
  if (!root) return;

  const PHONE_CODES = new Set(app.phonemes.map(p => p.c));
  const VOWELS = new Set([...app.vowels]);
  const SHORT = new Set(['P','T','K','B','D','G','CH','JH']);
  const GLIDES = new Set(['R','W','Y','L']);
  const FRICATIVES = new Set(['F','TH','S','SH','HH','V','DH','Z','ZH']);
  const NASALS = new Set(['M','N','NG']);
  const FUNCTION_WORDS = new Set(['a','an','the','and','or','but','if','of','to','for','in','on','at','by','as','is','are','was','were','be','been','being','it','its','this','that','these','those','i','you','he','she','we','they','my','your','his','her','our','their']);
  const EXPRESSIONS = {
    neutral:{base:0,decline:.12,stress:.15,q:.45,ex:.18,length:.03,tempo:1,energy:0,tone:0},
    natural:{base:0,decline:.92,stress:.68,q:2.20,ex:.82,length:.13,tempo:1,energy:0,tone:0},
    friendly:{base:.30,decline:.70,stress:.92,q:2.65,ex:.75,length:.12,tempo:1.01,energy:.32,tone:.75},
    excited:{base:.78,decline:.88,stress:1.28,q:3.05,ex:1.48,length:.08,tempo:1.08,energy:.90,tone:1.25},
    calm:{base:-.32,decline:.44,stress:.38,q:1.28,ex:.28,length:.18,tempo:.90,energy:-.38,tone:-.65},
    dramatic:{base:-.04,decline:1.42,stress:1.48,q:2.85,ex:1.30,length:.23,tempo:.93,energy:.48,tone:.30},
    storyteller:{base:.10,decline:1.08,stress:1.02,q:2.55,ex:.95,length:.17,tempo:.96,energy:.22,tone:.40},
    deadpan:{base:-.10,decline:.06,stress:.07,q:.16,ex:.04,length:.035,tempo:.97,energy:-.18,tone:-.20}
  };

  const state = {
    lines:[], nextId:1, selected:null, source:null, raf:0,
    bufferCache:new Map(), lineCache:new Map(), rendered:null, renderedStarts:[],
    renderVersion:1, loading:false
  };

  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dbGain=db=>Math.pow(10,db/20);
  const cleanName=s=>String(s||'conversation').trim().replace(/[^a-z0-9_-]+/gi,'-').replace(/^-+|-+$/g,'')||'conversation';
  function msg(t,kind=''){const e=$('convMessage');e.textContent=t;e.className='small conversation-message'+(kind==='bad'?' bad':kind==='good'?' good':'')}
  function invalidate(){state.rendered=null;state.renderedStarts=[];state.lineCache.clear();state.renderVersion++;renderChatPreview()}
  function voiceById(id){return app.voices.find(v=>v.id===id)||null}
  function firstVoiceId(){return app.voices[0]?.id||''}
  function defaultLine(text=''){return {id:state.nextId++,voiceId:firstVoiceId(),text,expression:'natural',expressionAmount:76,pitch:0,speed:1,gainDb:0,pan:0,pauseAfterMs:+$('convDefaultGap').value||260};}
  function voiceLabel(v){return v?app.voiceLabel(v):'Missing voice'}
  function art(v){return v?app.voiceArtUrl(v):''}

  function ensureLineVoices(){const fallback=firstVoiceId();for(const l of state.lines)if(!voiceById(l.voiceId))l.voiceId=fallback}
  function setLines(lines){state.lines=lines;ensureLineVoices();state.selected=state.lines[0]?.id||null;invalidate();renderLines()}
  function addLine(afterId=null,text=''){
    const line=defaultLine(text);let idx=state.lines.length;if(afterId!=null){const i=state.lines.findIndex(l=>l.id===afterId);if(i>=0)idx=i+1}state.lines.splice(idx,0,line);state.selected=line.id;invalidate();renderLines();setTimeout(()=>document.querySelector(`[data-conv-line="${line.id}"] textarea`)?.focus(),0);return line;
  }
  function duplicateLine(id){const i=state.lines.findIndex(l=>l.id===id);if(i<0)return;const copy={...state.lines[i],id:state.nextId++};state.lines.splice(i+1,0,copy);state.selected=copy.id;invalidate();renderLines()}
  function deleteLine(id){const i=state.lines.findIndex(l=>l.id===id);if(i<0)return;state.lines.splice(i,1);state.selected=state.lines[Math.min(i,state.lines.length-1)]?.id||null;invalidate();renderLines()}
  function moveLine(id,delta){const i=state.lines.findIndex(l=>l.id===id),j=i+delta;if(i<0||j<0||j>=state.lines.length)return;[state.lines[i],state.lines[j]]=[state.lines[j],state.lines[i]];invalidate();renderLines()}

  function optionHtml(selected){return app.voices.map(v=>`<option value="${esc(v.id)}" ${v.id===selected?'selected':''}>${esc(voiceLabel(v)+(v.temporary?' [browser test]':''))}</option>`).join('')||'<option value="">No voices loaded</option>'}
  function expressionOptions(sel){return Object.keys(EXPRESSIONS).map(k=>`<option value="${k}" ${k===sel?'selected':''}>${k[0].toUpperCase()+k.slice(1)}</option>`).join('')}
  function lineAvatar(v){const u=art(v);return u?`<img src="${esc(u)}" alt="">`:esc(v?.icon||v?.name?.slice(0,1)||'?')}
  function renderLines(){
    root.innerHTML='';$('convEmpty').hidden=!!state.lines.length;
    state.lines.forEach((l,i)=>{
      const v=voiceById(l.voiceId),el=document.createElement('article');el.className='conversation-line';el.dataset.convLine=l.id;
      el.innerHTML=`
        <div class="conversation-line-handle"><div class="conversation-line-number">${i+1}</div><button class="conversation-move" data-act="up" title="Move up">↑</button><button class="conversation-move" data-act="down" title="Move down">↓</button></div>
        <div class="conversation-avatar">${lineAvatar(v)}</div>
        <div class="conversation-line-body">
          <div class="conversation-line-top">
            <select class="text-input conv-voice">${optionHtml(l.voiceId)}</select>
            <select class="text-input conv-expression">${expressionOptions(l.expression)}</select>
            <div class="conversation-line-actions"><button class="button primary conv-preview">▶ Line</button><button class="button secondary" data-act="duplicate">Duplicate</button><button class="button secondary" data-act="add-after">+ Below</button><button class="button danger" data-act="delete">Delete</button></div>
          </div>
          <textarea class="conv-text" placeholder="What does this speaker say?">${esc(l.text)}</textarea>
          <div class="conversation-line-controls">
            <label class="conversation-control"><span>Expression</span><input class="conv-expression-amount" type="number" min="0" max="100" step="1" value="${l.expressionAmount}"></label>
            <label class="conversation-control"><span>Pitch (st)</span><input class="conv-pitch" type="number" min="-12" max="12" step="1" value="${l.pitch}"></label>
            <label class="conversation-control"><span>Speed</span><input class="conv-speed" type="number" min="0.55" max="2.2" step="0.05" value="${l.speed}"></label>
            <label class="conversation-control"><span>Gain (dB)</span><input class="conv-gain" type="number" min="-18" max="8" step="1" value="${l.gainDb}"></label>
            <label class="conversation-control"><span>Pan</span><input class="conv-pan" type="number" min="-100" max="100" step="5" value="${l.pan}"></label>
            <label class="conversation-control"><span>Pause after (ms)</span><input class="conv-gap ${l.pauseAfterMs<0?'conversation-gap-negative':''}" type="number" min="-1200" max="5000" step="25" value="${l.pauseAfterMs}"></label>
          </div>
          <div class="conversation-render-progress"><span></span></div>
        </div>`;
      const update=(key,val)=>{l[key]=val;invalidate()};
      el.querySelector('.conv-voice').onchange=e=>{update('voiceId',e.target.value);renderLines()};
      el.querySelector('.conv-expression').onchange=e=>update('expression',e.target.value);
      el.querySelector('.conv-text').oninput=e=>update('text',e.target.value);
      el.querySelector('.conv-expression-amount').onchange=e=>update('expressionAmount',clamp(+e.target.value||0,0,100));
      el.querySelector('.conv-pitch').onchange=e=>update('pitch',clamp(+e.target.value||0,-12,12));
      el.querySelector('.conv-speed').onchange=e=>update('speed',clamp(+e.target.value||1,.55,2.2));
      el.querySelector('.conv-gain').onchange=e=>update('gainDb',clamp(+e.target.value||0,-18,8));
      el.querySelector('.conv-pan').onchange=e=>update('pan',clamp(+e.target.value||0,-100,100));
      el.querySelector('.conv-gap').onchange=e=>{update('pauseAfterMs',clamp(+e.target.value||0,-1200,5000));e.target.classList.toggle('conversation-gap-negative',l.pauseAfterMs<0)};
      el.querySelector('.conv-preview').onclick=()=>playSingle(l.id);
      el.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>{const a=b.dataset.act;if(a==='up')moveLine(l.id,-1);if(a==='down')moveLine(l.id,1);if(a==='duplicate')duplicateLine(l.id);if(a==='add-after')addLine(l.id);if(a==='delete')deleteLine(l.id)});
      root.appendChild(el);
    });
    renderChatPreview();
  }

  function renderChatPreview(){
    const box=$('convChatPreview');box.innerHTML='';if(!state.lines.length){box.innerHTML='<div class="conversation-chat-empty">Your dialogue will appear here as a chat-style preview.</div>';return}
    const speakerSides=new Map();let side=0;
    for(const l of state.lines){const v=voiceById(l.voiceId);if(!speakerSides.has(l.voiceId)){speakerSides.set(l.voiceId,side%2);side++}const right=speakerSides.get(l.voiceId)===1,row=document.createElement('div');row.className='conversation-bubble-row'+(right?' right':'');const u=art(v);row.innerHTML=`<div class="conversation-bubble-avatar">${u?`<img src="${esc(u)}" alt="">`:esc(v?.icon||v?.name?.slice(0,1)||'?')}</div><div class="conversation-bubble-wrap"><div class="conversation-bubble-speaker">${esc(v?.name||'Missing voice')}</div><div class="conversation-bubble">${esc(l.text||'…')}</div><div class="conversation-bubble-meta">${esc(l.expression)} · ${l.pitch>=0?'+':''}${l.pitch} st · ${l.speed.toFixed?l.speed.toFixed(2):l.speed}×${l.pauseAfterMs<0?` · interrupts ${Math.abs(l.pauseAfterMs)} ms early`:''}</div></div>`;box.appendChild(row)}
  }

  async function buffersForVoice(v){
    if(!v)throw new Error('That line has no available voice.');if(state.bufferCache.has(v.id))return state.bufferCache.get(v.id);
    const ctx=app.getAudioCtx();const pairs=await Promise.all(app.phonemes.map(async p=>{
      try{
        let ab;if(v.temporary&&v._sampleBytes){ab=v._sampleBytes.get(p.c);if(!ab)return[p.c,null];ab=ab.slice(0)}else{const r=await fetch(`${v.base_url}/samples/${p.c}.wav`,{cache:'no-store'});if(!r.ok)return[p.c,null];ab=await r.arrayBuffer()}
        return[p.c,await ctx.decodeAudioData(ab.slice(0))]
      }catch{return[p.c,null]}
    }));const m=new Map(pairs.filter(x=>x[1]));state.bufferCache.set(v.id,m);return m;
  }

  function numberWords(n){const small=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'],tens=['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];n=+n;if(n<20)return small[n]||String(n);if(n<100)return tens[Math.floor(n/10)]+(n%10?' '+small[n%10]:'');if(n<1000)return small[Math.floor(n/100)]+' hundred'+(n%100?' '+numberWords(n%100):'');return String(n).split('').map(d=>small[+d]).join(' ')}
  function tokensForText(text){
    const raw=String(text||'').match(/[A-Za-z]+(?:'[A-Za-z]+)?|\d+|[.,!?;:…]+|[-–—]/g)||[],out=[];let wordIndex=0,sentence=0,lastWord=false;
    const addWord=(word,display=word)=>{const p=app.wordPron(word),auto=display.length>1&&display===display.toUpperCase()&&/[A-Z]/.test(display);if(lastWord)out.push({type:'word'});p.detailed.forEach((ph,idx)=>out.push({type:'phone',code:ph.code,stress:ph.stress||0,word:String(word).toLowerCase(),wordIndex,phoneIndex:idx,phoneCount:p.detailed.length,autoEmphasis:auto,sentenceIndex:sentence}));wordIndex++;lastWord=true};
    for(const t of raw){if(/^\d+$/.test(t)){for(const w of numberWords(t).split(/\s+/))addWord(w,w);continue}if(/^[A-Za-z]/.test(t)){addWord(t,t);continue}if(/[.!?…]/.test(t)){out.push({type:'pause',ms:260,mark:t,sentenceEnd:true});sentence++;lastWord=false}else if(/[,;:]/.test(t)){out.push({type:'pause',ms:135,mark:t,phraseBreak:true});lastWord=false}else if(/[-–—]/.test(t)){out.push({type:'pause',ms:90,mark:t,phraseBreak:true});lastWord=false}}
    return out;
  }
  function sentenceInfo(tokens){const map=new Map();let s=[],p=[];const put=(arr,type,mark)=>{const n=arr.length;arr.forEach((idx,i)=>{const o=map.get(idx)||{};if(type==='s'){o.pos=n<=1?1:i/(n-1);o.endMark=mark||''}else{o.phrasePos=n<=1?1:i/(n-1);o.phraseMark=mark||''}map.set(idx,o)});arr.length=0};for(let i=0;i<tokens.length;i++){const t=tokens[i];if(t.type==='phone'){s.push(i);p.push(i)}else if(t.type==='pause'){const mark=t.mark||'',end=t.sentenceEnd||/[.!?…]/.test(mark);if(end||t.phraseBreak||/[,;:—–-]/.test(mark))put(p,'p',mark);if(end)put(s,'s',mark)}}put(p,'p','');put(s,'s','');return map}
  function nextPhone(tokens,i){for(let j=i+1;j<tokens.length;j++){if(tokens[j].type==='phone')return tokens[j].code;if(tokens[j].type==='pause')return null}return null}
  function phoneClass(c){if(SHORT.has(c))return'stop';if(VOWELS.has(c))return'vowel';if(GLIDES.has(c))return'glide';if(FRICATIVES.has(c))return'fricative';if(NASALS.has(c))return'nasal';return'other'}
  function overlapSeconds(a,b,base=.022){const A=phoneClass(a),B=phoneClass(b);let mul=1,cap=.060;if(A==='stop'||B==='stop'){mul=.28;cap=.010}else if(A==='vowel'&&B==='vowel'){mul=1.18;cap=.050}else if(A==='fricative'&&B==='stop'||A==='stop'&&B==='fricative'){mul=.34;cap=.012}else if(A==='glide'||B==='glide'){mul=1.05;cap=.043}else if(A==='fricative'&&B==='fricative'){mul=.72;cap=.030}return Math.min(cap,base*mul)}
  function seeded(id,i,salt){let x=((id+1)*0x9e3779b1^(i+salt)*0x85ebca6b)>>>0;x^=x>>>16;x=Math.imul(x,0x7feb352d);x^=x>>>15;return ((x>>>0)/4294967295)*2-1}

  async function renderLine(line,progress){
    const cacheKey=JSON.stringify([state.renderVersion,line.id,line.voiceId,line.text,line.expression,line.expressionAmount,line.pitch,line.speed,line.gainDb]);if(state.lineCache.has(cacheKey))return state.lineCache.get(cacheKey);
    const voice=voiceById(line.voiceId);if(!voice)throw new Error(`Line ${state.lines.indexOf(line)+1}: voice is unavailable.`);const buffers=await buffersForVoice(voice),tokens=tokensForText(line.text);if(!tokens.some(t=>t.type==='phone'))throw new Error(`Line ${state.lines.indexOf(line)+1} has no speakable text.`);
    const missing=[...new Set(tokens.filter(t=>t.type==='phone'&&!buffers.has(t.code)).map(t=>t.code))];if(missing.length)throw new Error(`${voice.name} is missing ${missing.join(', ')}.`);
    const prof=EXPRESSIONS[line.expression]||EXPRESSIONS.natural,amount=clamp(line.expressionAmount/100,0,1),sr=48000,temp=new OfflineAudioContext(1,sr,sr),info=sentenceInfo(tokens),events=[],cache=new Map();let time=.025,ordinal=0;
    const phonesTotal=tokens.filter(t=>t.type==='phone').length;for(let i=0;i<tokens.length;i++){
      const tok=tokens[i];if(tok.type==='word'){time+=.038;continue}if(tok.type==='pause'){let p=tok.ms/1000;if((tok.mark||'').includes('…'))p*=1.35;if((tok.mark||'').includes('!'))p*=.88;time+=p;continue}
      const si=info.get(i)||{pos:.5,phrasePos:.5,endMark:'',phraseMark:''},pos=si.pos??.5,pp=si.phrasePos??.5,mark=si.endMark||'',vowel=VOWELS.has(tok.code),primary=tok.stress===1,secondary=tok.stress===2,fn=FUNCTION_WORDS.has(tok.word),emph=tok.autoEmphasis;
      let pitch=line.pitch+prof.base*amount+(0.46-pos)*prof.decline*amount;if(pp<.22)pitch+=(1-pp/.22)*.20*amount;if(vowel&&(primary||secondary))pitch+=(primary?prof.stress:prof.stress*.48)*amount;if(fn&&!emph)pitch-=.12*amount;if(emph)pitch+=(vowel?1.05:.35)*amount;
      if(mark.includes('?')&&pos>.60)pitch+=Math.pow((pos-.60)/.40,1.4)*prof.q*amount;else if(mark.includes('!')&&pos>.64)pitch+=Math.pow((pos-.64)/.36,1.08)*prof.ex*amount;else if(mark&&pos>.80)pitch-=((pos-.80)/.20)*.35*prof.decline*amount;if(mark.includes('…')&&pos>.68)pitch-=((pos-.68)/.32)*.70*amount;
      pitch+=seeded(line.id,ordinal,17)*.06*amount;
      let dur=1;if(vowel&&(primary||secondary))dur+=.10*(primary?1:.45)*amount;if(fn&&!emph)dur-=.04*amount;if(emph&&vowel)dur+=.16*amount;if(pos>.86)dur+=prof.length*((pos-.86)/.14)*amount;dur=clamp(dur,.75,1.45);
      const source=buffers.get(tok.code),sourceScale=clamp(dur,.84,1.22),maxSource=Math.min(source.duration,app.speechMaxSourceSeconds(tok.code)*sourceScale),speed=clamp(line.speed*prof.tempo/dur,.38,3.0),pq=Math.round(pitch*20)/20,sq=Math.round(speed*100)/100,mq=Math.round(maxSource*1000)/1000,key=`${tok.code}|${pq}|${sq}|${mq}`;let buf=cache.get(key);if(!buf){buf=MainVoiceDSP.toAudioBuffer(temp,source,{pitchSemitones:pq,speed:sq,maxSourceSeconds:mq});cache.set(key,buf)}const ov=Math.min(overlapSeconds(tok.code,nextPhone(tokens,i),.023),buf.duration*.52);let gain=prof.energy*amount+(vowel&&primary?.38*amount:0)+(emph?1.1*amount:0);events.push({when:time,buf,ov,gain});time+=Math.max(.014,buf.duration-ov);ordinal++;if(progress)progress(ordinal/phonesTotal)
    }
    const total=time+.055,off=new OfflineAudioContext(1,Math.ceil(total*sr),sr),master=off.createGain(),tone=off.createBiquadFilter(),comp=off.createDynamicsCompressor();master.gain.value=dbGain(line.gainDb);tone.type='highshelf';tone.frequency.value=2600;tone.gain.value=prof.tone*amount;comp.threshold.value=-8;comp.knee.value=8;comp.ratio.value=3;comp.attack.value=.004;comp.release.value=.12;master.connect(tone);tone.connect(comp);comp.connect(off.destination);
    for(const e of events){const s=off.createBufferSource(),g=off.createGain();s.buffer=e.buf;s.connect(g);g.connect(master);const d=e.buf.duration,c=Math.min(Math.max(.0025,e.ov*.55),.024,d*.28),pk=dbGain(e.gain);g.gain.setValueAtTime(0,e.when);g.gain.linearRampToValueAtTime(pk,e.when+c);g.gain.setValueAtTime(pk,Math.max(e.when+c,e.when+d-c));g.gain.linearRampToValueAtTime(0,e.when+d);s.start(e.when)}const rendered=await off.startRendering();state.lineCache.set(cacheKey,rendered);if(progress)progress(1);return rendered;
  }

  async function renderConversation(){
    if(!state.lines.length)throw new Error('Add at least one dialogue line.');const usable=state.lines.filter(l=>String(l.text).trim());if(!usable.length)throw new Error('Every dialogue line is empty.');stop();state.loading=true;msg('Rendering dialogue…');const rendered=[],starts=[];let cursor=.03;
    for(let i=0;i<usable.length;i++){const l=usable[i],el=document.querySelector(`[data-conv-line="${l.id}"]`),bar=el?.querySelector('.conversation-render-progress>span');if(bar)bar.style.width='0%';el?.classList.add('playing');const b=await renderLine(l,p=>{if(bar)bar.style.width=`${Math.round(p*100)}%`});rendered.push({line:l,buffer:b});starts.push(cursor);cursor=Math.max(0,cursor+b.duration+l.pauseAfterMs/1000);el?.classList.remove('playing');if(bar)bar.style.width='100%';msg(`Rendered ${i+1}/${usable.length}: ${voiceById(l.voiceId)?.name||'voice'}`)}
    const total=Math.max(...rendered.map((x,i)=>starts[i]+x.buffer.duration),.1)+.08,sr=48000,off=new OfflineAudioContext(2,Math.ceil(total*sr),sr),master=off.createGain(),comp=off.createDynamicsCompressor();master.gain.value=dbGain(clamp(+$('convMasterGain').value||0,-18,6));comp.threshold.value=-6;comp.knee.value=7;comp.ratio.value=2.4;comp.attack.value=.004;comp.release.value=.14;master.connect(comp);comp.connect(off.destination);
    rendered.forEach((r,i)=>{const s=off.createBufferSource(),g=off.createGain();s.buffer=r.buffer;s.connect(g);g.gain.value=1;let last=g;if(off.createStereoPanner){const p=off.createStereoPanner();p.pan.value=clamp(r.line.pan/100,-1,1);g.connect(p);last=p}last.connect(master);s.start(starts[i])});const mix=await off.startRendering();state.rendered=mix;state.renderedStarts=starts;state.loading=false;msg(`Ready — ${usable.length} lines, ${mix.duration.toFixed(2)} seconds.`,'good');return mix;
  }

  function stop(){if(state.source){try{state.source.stop()}catch{}state.source=null}cancelAnimationFrame(state.raf);state.raf=0;document.querySelectorAll('.conversation-line.playing').forEach(e=>e.classList.remove('playing'));app.stopSpeech?.()}
  function playBuffer(buf,startMap=null){stop();const ctx=app.getAudioCtx(),s=ctx.createBufferSource();s.buffer=buf;s.connect(ctx.destination);s.start();state.source=s;const started=performance.now();const tick=()=>{if(!state.source)return;const sec=(performance.now()-started)/1000;if(startMap?.length){let idx=0;for(let i=0;i<startMap.length;i++)if(startMap[i]<=sec)idx=i;document.querySelectorAll('.conversation-line').forEach(e=>e.classList.remove('playing'));const line=state.lines.filter(l=>String(l.text).trim())[idx];if(line)document.querySelector(`[data-conv-line="${line.id}"]`)?.classList.add('playing')}state.raf=requestAnimationFrame(tick)};tick();s.onended=()=>{if(state.source===s)state.source=null;cancelAnimationFrame(state.raf);state.raf=0;document.querySelectorAll('.conversation-line.playing').forEach(e=>e.classList.remove('playing'))}}
  async function playAll(){try{$('convPlayBtn').disabled=true;const b=await renderConversation();playBuffer(b,state.renderedStarts)}catch(e){state.loading=false;msg(e.message,'bad')}finally{$('convPlayBtn').disabled=false}}
  async function playSingle(id){const l=state.lines.find(x=>x.id===id);if(!l)return;try{msg(`Rendering line ${state.lines.indexOf(l)+1}…`);const b=await renderLine(l);playBuffer(b);msg(`Previewing ${voiceById(l.voiceId)?.name||'voice'}.`,'good')}catch(e){msg(e.message,'bad')}}
  async function exportWav(){try{$('convExportBtn').disabled=true;const b=await renderConversation(),name=cleanName($('convTitle').value);app.download(new Blob([encodeStereoWav(b)],{type:'audio/wav'}),name+'.wav');msg('Stereo conversation WAV exported.','good')}catch(e){msg(e.message,'bad')}finally{$('convExportBtn').disabled=false}}
  function encodeStereoWav(buf){const ch=buf.numberOfChannels>=2?2:1,n=buf.length,ab=new ArrayBuffer(44+n*ch*2),dv=new DataView(ab),put=(o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i))};put(0,'RIFF');dv.setUint32(4,36+n*ch*2,true);put(8,'WAVE');put(12,'fmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,ch,true);dv.setUint32(24,buf.sampleRate,true);dv.setUint32(28,buf.sampleRate*ch*2,true);dv.setUint16(32,ch*2,true);dv.setUint16(34,16,true);put(36,'data');dv.setUint32(40,n*ch*2,true);const a=buf.getChannelData(0),b=ch===2?buf.getChannelData(1):a;let o=44;for(let i=0;i<n;i++){for(const x of ch===2?[a[i],b[i]]:[a[i]]){const s=clamp(x,-1,1);dv.setInt16(o,s<0?s*32768:s*32767,true);o+=2}}return ab}

  function alternateVoices(){if(app.voices.length<2){msg('Load at least two voices to alternate speakers.','bad');return}state.lines.forEach((l,i)=>l.voiceId=app.voices[i%app.voices.length].id);invalidate();renderLines();msg(`Alternated ${app.voices.length} available voices.`,'good')}
  function demo(){if(!app.voices.length){msg('Load a voice first.','bad');return}const a=app.voices[0].id,b=app.voices[1]?.id||a;setLines([{...defaultLine('Okay, so whose idea was this?'),voiceId:a,expression:'natural',pauseAfterMs:180},{...defaultLine('I was hoping you would not ask that.'),voiceId:b,expression:'deadpan',pitch:-1,pauseAfterMs:260},{...defaultLine('That is absolutely not an answer!'),voiceId:a,expression:'excited',expressionAmount:92,pauseAfterMs:-170},{...defaultLine('Technically, it was a sentence.'),voiceId:b,expression:'calm',pauseAfterMs:300}]);msg('Loaded a demo with expression changes and one interruption.','good')}
  function parseScript(append=false){const raw=$('convScriptImport').value.trim();if(!raw){msg('Paste a script first.','bad');return}const voices=app.voices;if(!voices.length){msg('No voices are available yet.','bad');return}const byName=new Map();voices.forEach(v=>{byName.set(v.id.toLowerCase(),v.id);byName.set(String(v.name||'').toLowerCase(),v.id)});const lines=[];for(const [i,row] of raw.split(/\r?\n/).entries()){if(!row.trim())continue;let text=row.trim(),voiceId=voices[i%voices.length].id;const m=text.match(/^([^:]{1,60}):\s*(.+)$/);if(m){const found=byName.get(m[1].trim().toLowerCase());if(found){voiceId=found;text=m[2].trim()}}lines.push({...defaultLine(text),voiceId})}if(!lines.length){msg('No dialogue lines were found.','bad');return}if(append)state.lines.push(...lines);else state.lines=lines;state.selected=state.lines[0]?.id||null;invalidate();renderLines();msg(`${append?'Appended':'Imported'} ${lines.length} lines.`,'good')}
  function project(){return {format:'mainvoice-conversation-1',title:$('convTitle').value||'Untitled Conversation',defaultGapMs:+$('convDefaultGap').value||260,masterGainDb:+$('convMasterGain').value||0,lines:state.lines.map(l=>({...l}))}}
  async function loadProject(f){try{const p=JSON.parse(await f.text());if(p.format!=='mainvoice-conversation-1')throw new Error('That is not a MainVoice conversation project.');$('convTitle').value=p.title||'Untitled Conversation';$('convDefaultGap').value=clamp(+p.defaultGapMs||260,-1200,5000);$('convMasterGain').value=clamp(+p.masterGainDb||0,-18,6);state.lines=(Array.isArray(p.lines)?p.lines:[]).map(x=>({id:state.nextId++,voiceId:String(x.voiceId||firstVoiceId()),text:String(x.text||''),expression:EXPRESSIONS[x.expression]?x.expression:'natural',expressionAmount:clamp(+x.expressionAmount||76,0,100),pitch:clamp(+x.pitch||0,-12,12),speed:clamp(+x.speed||1,.55,2.2),gainDb:clamp(+x.gainDb||0,-18,8),pan:clamp(+x.pan||0,-100,100),pauseAfterMs:clamp(Number.isFinite(+x.pauseAfterMs)?+x.pauseAfterMs:260,-1200,5000)}));ensureLineVoices();invalidate();renderLines();msg(`Loaded ${state.lines.length} dialogue lines from ${f.name}.`,'good')}catch(e){msg(e.message,'bad')}}

  $('convAddLineBtn').onclick=()=>addLine();$('convEmptyAddBtn').onclick=()=>addLine();$('convAlternateBtn').onclick=alternateVoices;$('convDemoBtn').onclick=demo;$('convPlayBtn').onclick=playAll;$('convStopBtn').onclick=stop;$('convExportBtn').onclick=exportWav;$('convImportScriptBtn').onclick=()=>parseScript(false);$('convAppendScriptBtn').onclick=()=>parseScript(true);
  $('convSaveBtn').onclick=()=>{const p=project();app.download(new Blob([JSON.stringify(p,null,2)],{type:'application/json'}),cleanName(p.title)+'.mainvoice-conversation.json');msg('Conversation project saved.','good')};$('convLoadInput').onchange=async e=>{const f=e.target.files?.[0];if(f)await loadProject(f);e.target.value=''};
  $('convClearBtn').onclick=()=>{if(state.lines.length&&!confirm('Clear the entire conversation?'))return;stop();setLines([]);msg('Conversation cleared.')};
  $('convDefaultGap').onchange=e=>{e.target.value=clamp(+e.target.value||260,-1200,5000)};$('convMasterGain').onchange=()=>invalidate();
  document.addEventListener('mainvoice:voiceschange',()=>{ensureLineVoices();state.bufferCache.clear();invalidate();renderLines()});

  // Start with two blank-ish lines only after voices become available, otherwise the empty state is clearer.
  renderLines();
})();
