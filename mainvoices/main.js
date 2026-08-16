(() => {
  'use strict';
  const P = window.PHONEMES, PM = window.PHONEME_MAP;
  const $ = id => document.getElementById(id);
  const state = {voices:[],voice:null,buffers:new Map(),dict:null,audioCtx:null,currentSource:null,generated:'',active:'',manual:false,unknown:[],rendered:null};

  function setStatus(msg,kind='ok'){$('globalStatus').textContent=msg;$('statusDot').className='dot'+(kind==='busy'?' busy':kind==='bad'?' bad':'')}
  function switchTab(name){document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='tab-'+name))}
  function getAudioCtx(){if(!state.audioCtx){const AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw new Error('Web Audio is not supported here.');state.audioCtx=new AC()}if(state.audioCtx.state==='suspended')state.audioCtx.resume().catch(()=>{});return state.audioCtx}
  function stopPlayback(){if(state.currentSource){try{state.currentSource.stop()}catch{}state.currentSource=null}}
  function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

  async function loadDictionary(){setStatus('loading pronunciation dictionary','busy');const r=await fetch('data/cmudict.json');if(!r.ok)throw new Error('Could not load data/cmudict.json');state.dict=await r.json();setStatus('dictionary ready')}

  function numberWords(n){
    const small=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'],tens=['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
    n=Number(n);if(!Number.isFinite(n)||n<0||n>999999)return String(n).split('').map(d=>small[+d]||'').join(' ');if(n<20)return small[n];if(n<100)return tens[Math.floor(n/10)]+(n%10?' '+small[n%10]:'');if(n<1000)return small[Math.floor(n/100)]+' hundred'+(n%100?' '+numberWords(n%100):'');if(n<1000000)return numberWords(Math.floor(n/1000))+' thousand'+(n%1000?' '+numberWords(n%1000):'');return String(n)
  }
  function dictPron(word){const key=word.toLowerCase();let v=state.dict?.[key];if(!v&&key.endsWith("'s"))v=state.dict?.[key.slice(0,-2)];if(!v)return null;return v.map(x=>x.replace(/[012]$/,''))}
  function fallbackPron(word){
    let s=word.toLowerCase().replace(/[^a-z]/g,'');if(!s)return[];
    const out=[];const vowel={a:'AE',e:'EH',i:'IH',o:'AA',u:'AH',y:'IY'};const one={b:'B',c:'K',d:'D',f:'F',g:'G',h:'HH',j:'JH',k:'K',l:'L',m:'M',n:'N',p:'P',q:'K',r:'R',s:'S',t:'T',v:'V',w:'W',x:null,z:'Z'};
    const rules=[['tion',['SH','AH','N']],['sion',['ZH','AH','N']],['tch',['CH']],['dge',['JH']],['igh',['AY']],['eigh',['EY']],['ch',['CH']],['sh',['SH']],['th',['TH']],['ph',['F']],['ng',['NG']],['wh',['W']],['qu',['K','W']],['ck',['K']],['ee',['IY']],['ea',['IY']],['oo',['UW']],['oi',['OY']],['oy',['OY']],['ai',['EY']],['ay',['EY']],['ow',['AW']],['ou',['AW']],['er',['ER']],['ir',['ER']],['ur',['ER']],['ar',['AA','R']],['or',['AO','R']]];
    for(let i=0;i<s.length;){let matched=false;for(const [pat,ph] of rules){if(s.startsWith(pat,i)){out.push(...ph);i+=pat.length;matched=true;break}}if(matched)continue;const c=s[i];if(c==='x'){out.push('K','S');i++;continue}if(vowel[c]){if(c==='e'&&i===s.length-1&&s.length>2){i++;continue}out.push(vowel[c]);i++;continue}if(one[c])out.push(one[c]);i++}
    return out;
  }
  function wordPron(word){const d=dictPron(word);return d?{phones:d,unknown:false}:{phones:fallbackPron(word),unknown:true}}
  function tokenizeText(text){return text.match(/[A-Za-z]+(?:'[A-Za-z]+)?|\d+|[.,!?;:…]+|[-–—]/g)||[]}
  function buildPronunciation(){
    if(!state.dict)return;
    const text=$('textInput').value.trim(),toks=tokenizeText(text),parts=[],unknown=[];let words=0,phones=0,lastWasWord=false;
    for(const tok of toks){
      if(/^\d+$/.test(tok)){const expanded=numberWords(tok).split(/\s+/);for(const w of expanded){const p=wordPron(w);if(lastWasWord)parts.push('/');parts.push(...p.phones);phones+=p.phones.length;words++;lastWasWord=true}continue}
      if(/^[A-Za-z]/.test(tok)){const p=wordPron(tok);if(lastWasWord)parts.push('/');parts.push(...p.phones);phones+=p.phones.length;words++;if(p.unknown)unknown.push(tok);lastWasWord=true;continue}
      if(/[.!?…]/.test(tok)){parts.push(`|${+$('punctGap').value}|`);lastWasWord=false}else if(/[,;:]/.test(tok)){parts.push(`|${Math.round(+$('punctGap').value*.55)}|`);lastWasWord=false}else if(/[-–—]/.test(tok)){parts.push(`|${Math.round(+$('wordGap').value*1.5)}|`);lastWasWord=false}
    }
    state.generated=parts.join(' ').replace(/\s+\|/g,' |').replace(/\|\s+/g,'| ').trim();if(!state.manual)state.active=state.generated;state.unknown=unknown;$('advancedInput').value=state.active;$('phonemePreview').textContent=state.active||'—';renderAnalysis(words,phones,unknown);state.rendered=null;
  }
  function renderAnalysis(words,phones,unknown){const r=$('analysisStrip');r.innerHTML='';const add=(txt,warn=false)=>{const s=document.createElement('span');s.className='chip'+(warn?' warn':'');s.textContent=txt;r.appendChild(s)};add(`${words} word${words===1?'':'s'}`);add(`${phones} phoneme${phones===1?'':'s'}`);if(unknown.length)add(`${unknown.length} fallback: ${[...new Set(unknown)].slice(0,4).join(', ')}${unknown.length>4?'…':''}`,true);else add('dictionary pronunciation ✓')}

  function parseSequence(seq){
    const raw=seq.toUpperCase().match(/\|\d+\||\/|[A-Z]{1,3}[012]?/g)||[],tokens=[],bad=[];
    for(const x of raw){if(x==='/'){tokens.push({type:'word'})}else if(/^\|\d+\|$/.test(x)){tokens.push({type:'pause',ms:+x.slice(1,-1)})}else{const c=x.replace(/[012]$/,'');if(PM[c])tokens.push({type:'phone',code:c});else bad.push(c)}}return {tokens,bad}
  }
  function synthesisSettings(){return {speed:+$('speed').value,pitch:+$('pitch').value,overlap:+$('overlap').value,wordGap:+$('wordGap').value,punctGap:+$('punctGap').value,gainDb:+$('gain').value}}

  // The main TTS uses the same speech-sized units as the Continuous Speech test.
  // Long setup recordings are useful for judging a raw phoneme, but playing the
  // whole recording for every occurrence makes ordinary text sound sample-by-sample.
  const SPEECH_SHORT=new Set(['P','T','K','B','D','G','CH','JH']);
  const SPEECH_GLIDE=new Set(['R','W','Y','L']);
  const SPEECH_FRICATIVE=new Set(['F','TH','S','SH','HH','V','DH','Z','ZH']);
  const SPEECH_NASAL=new Set(['M','N','NG']);
  const SPEECH_DIPHTHONG=new Set(['AY','AW','EY','OW','OY']);
  function speechMaxSourceSeconds(code){
    if(SPEECH_SHORT.has(code))return .115;
    if(SPEECH_GLIDE.has(code))return .16;
    if(SPEECH_FRICATIVE.has(code))return .145;
    if(SPEECH_NASAL.has(code))return .17;
    if(SPEECH_DIPHTHONG.has(code))return .205;
    return .18;
  }

  async function renderSpeech(){
    if(!state.voice)throw new Error('Install/select a voice first.');
    const parsed=parseSequence(state.active||state.generated);
    if(parsed.bad.length)throw new Error('Unknown phoneme code(s): '+[...new Set(parsed.bad)].join(', '));
    const missing=[...new Set(parsed.tokens.filter(t=>t.type==='phone'&&!state.buffers.has(t.code)).map(t=>t.code))];
    if(missing.length)throw new Error('This voice is missing: '+missing.join(', '));
    if(!parsed.tokens.some(t=>t.type==='phone'))throw new Error('There are no phonemes to synthesize.');

    const settings=synthesisSettings(),sr=48000,overlap=Math.max(0,settings.overlap)/1000;

    // Process each phoneme once first, then schedule using the *actual* processed
    // duration. This is what keeps pitch, speed and overlap from fighting each other.
    const temp=new OfflineAudioContext(1,sr,sr);
    const processed=new Map();
    for(const code of new Set(parsed.tokens.filter(t=>t.type==='phone').map(t=>t.code))){
      const source=state.buffers.get(code),maxSourceSeconds=Math.min(source.duration,speechMaxSourceSeconds(code));
      const out=MainVoiceDSP.toAudioBuffer(temp,source,{pitchSemitones:settings.pitch,speed:settings.speed,maxSourceSeconds});
      processed.set(code,out);
    }

    const events=[];let t=.04;
    for(const tok of parsed.tokens){
      if(tok.type==='word'){t+=settings.wordGap/1000;continue}
      if(tok.type==='pause'){t+=tok.ms/1000;continue}
      const buf=processed.get(tok.code);if(!buf)continue;
      const dur=buf.duration,ov=Math.min(overlap,dur*.60);
      events.push({code:tok.code,when:t,buffer:buf,overlap:ov});
      t+=Math.max(.018,dur-ov);
    }

    const total=t+.08,length=Math.max(1,Math.ceil(total*sr)),off=new OfflineAudioContext(1,length,sr),master=off.createGain();
    master.gain.value=Math.pow(10,settings.gainDb/20);master.connect(off.destination);
    for(const ev of events){
      const src=off.createBufferSource(),g=off.createGain();src.buffer=ev.buffer;src.connect(g);g.connect(master);
      const dur=src.buffer.duration;
      // Crossfade proportion follows the Continuous Speech tester, with a tiny
      // edge fade even at 0 ms overlap to avoid hard digital clicks.
      const cross=Math.min(Math.max(.003,ev.overlap*.55),.024,dur*.28);
      g.gain.setValueAtTime(0,ev.when);
      g.gain.linearRampToValueAtTime(1,ev.when+cross);
      g.gain.setValueAtTime(1,Math.max(ev.when+cross,ev.when+dur-cross));
      g.gain.linearRampToValueAtTime(0,ev.when+dur);
      src.start(ev.when);
    }
    return off.startRendering();
  }
  async function speak(){stopPlayback();try{setStatus('synthesizing','busy');$('speakBtn').disabled=true;const buf=await renderSpeech();state.rendered=buf;const ctx=getAudioCtx(),src=ctx.createBufferSource();src.buffer=buf;src.connect(ctx.destination);src.start();state.currentSource=src;src.onended=()=>{if(state.currentSource===src)state.currentSource=null};setStatus('playing');$('synthMessage').textContent=`Rendered ${(buf.duration).toFixed(2)} seconds with ${state.voice.name}.`}catch(e){setStatus('synthesis failed','bad');$('synthMessage').textContent=e.message}finally{$('speakBtn').disabled=false}}
  function encodeWav(buf){const d=buf.getChannelData(0),ab=new ArrayBuffer(44+d.length*2),dv=new DataView(ab),put=(o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i))};put(0,'RIFF');dv.setUint32(4,36+d.length*2,true);put(8,'WAVE');put(12,'fmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,1,true);dv.setUint32(24,buf.sampleRate,true);dv.setUint32(28,buf.sampleRate*2,true);dv.setUint16(32,2,true);dv.setUint16(34,16,true);put(36,'data');dv.setUint32(40,d.length*2,true);let o=44;for(let i=0;i<d.length;i++,o+=2){const s=Math.max(-1,Math.min(1,d[i]));dv.setInt16(o,s<0?s*32768:s*32767,true)}return ab}
  function download(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),3000)}
  async function exportWav(){try{setStatus('rendering WAV','busy');const buf=await renderSpeech();state.rendered=buf;download(new Blob([encodeWav(buf)],{type:'audio/wav'}),`${(state.voice?.id||'voice')}-speech.wav`);setStatus('WAV exported')}catch(e){setStatus('export failed','bad');$('synthMessage').textContent=e.message}}

  function readU16(dv,o){return dv.getUint16(o,true)}
  function readU32(dv,o){return dv.getUint32(o,true)}
  async function inflateZipData(bytes,method){
    if(method===0)return bytes.slice();
    if(method===8){
      if(!('DecompressionStream' in window))throw new Error('This ZIP is compressed in a way this browser cannot unpack. MainVoice ZIPs exported by the setup wizard work without extra libraries.');
      let ds;try{ds=new DecompressionStream('deflate-raw')}catch{throw new Error('This browser cannot decode deflated ZIP entries. Try the original MainVoice ZIP exported by the setup wizard.')}
      const stream=new Blob([bytes]).stream().pipeThrough(ds);return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('Unsupported ZIP compression method '+method+'.');
  }
  async function readZipEntries(file){
    const ab=await file.arrayBuffer(),dv=new DataView(ab),bytes=new Uint8Array(ab),min=Math.max(0,bytes.length-65557);let eocd=-1;
    for(let i=bytes.length-22;i>=min;i--){if(readU32(dv,i)===0x06054b50){eocd=i;break}}
    if(eocd<0)throw new Error('That does not look like a normal ZIP file.');
    const count=readU16(dv,eocd+10),cdOffset=readU32(dv,eocd+16),dec=new TextDecoder(),entries=new Map();let pos=cdOffset;
    for(let n=0;n<count;n++){
      if(readU32(dv,pos)!==0x02014b50)throw new Error('The ZIP directory is damaged or unsupported.');
      const method=readU16(dv,pos+10),compSize=readU32(dv,pos+20),nameLen=readU16(dv,pos+28),extraLen=readU16(dv,pos+30),commentLen=readU16(dv,pos+32),localOffset=readU32(dv,pos+42),name=dec.decode(bytes.subarray(pos+46,pos+46+nameLen)).replaceAll('\\','/');
      if(readU32(dv,localOffset)!==0x04034b50)throw new Error('The ZIP has an invalid local file header.');
      const localNameLen=readU16(dv,localOffset+26),localExtraLen=readU16(dv,localOffset+28),dataStart=localOffset+30+localNameLen+localExtraLen,compressed=bytes.subarray(dataStart,dataStart+compSize);
      if(!name.endsWith('/'))entries.set(name,await inflateZipData(compressed,method));
      pos+=46+nameLen+extraLen+commentLen;
    }
    return entries;
  }
  function voiceTags(v){return Array.isArray(v?.tags)?v.tags.map(x=>String(x).trim()).filter(Boolean).slice(0,12):[]}
  function voiceLabel(v){return `${v.icon?String(v.icon).trim()+' ':''}${v.name||'Unnamed voice'}`}
  function voiceArtUrl(v){if(!v)return'';if(v.temporary&&v._artUrl)return v._artUrl;if(v.artFile&&v.base_url)return `${v.base_url}/${encodeURIComponent(String(v.artFile))}`;return''}
  function revokeTempArt(v){if(v?.temporary&&v._artUrl){try{URL.revokeObjectURL(v._artUrl)}catch{}v._artUrl=''}}
  function setBrowserPackStatus(text,kind=''){
    for(const id of ['browserPackStatus']){const el=$(id);if(el){el.textContent=text;el.className='small'+(kind==='bad'?' browser-pack-bad':kind==='good'?' browser-pack-good':'')}}
  }
  async function importBrowserPack(file){
    if(!file)return;
    stopPlayback();setStatus('opening browser voice pack','busy');setBrowserPackStatus('Reading ZIP and decoding phoneme samples…');
    try{
      const entries=await readZipEntries(file),voicePath=[...entries.keys()].find(n=>/(^|\/)voice\.json$/i.test(n));
      if(!voicePath)throw new Error('No voice.json was found. Choose an exported *-mainvoice.zip pack, not the whole MainVoice app ZIP.');
      const meta=JSON.parse(new TextDecoder().decode(entries.get(voicePath)));
      if(meta.format!=='mainvoice-pack-1')throw new Error('That voice.json is not a supported MainVoice pack.');
      const prefix=voicePath.slice(0,-'voice.json'.length),sampleBytes=new Map();
      for(const ph of P){const key=[...entries.keys()].find(n=>n.toLowerCase()===(prefix+'samples/'+ph.c+'.wav').toLowerCase());if(key)sampleBytes.set(ph.c,entries.get(key).slice().buffer)}
      if(!sampleBytes.size)throw new Error('The pack has voice.json, but no samples/*.wav phoneme files were found.');
      let artUrl='',artFile='';const artCandidates=[meta.artFile,'character.png','character.webp','character.jpg','art.png'].filter(Boolean).map(x=>String(x).replace(/^\/+/,''));
      for(const candidate of artCandidates){const key=[...entries.keys()].find(n=>n.toLowerCase()===(prefix+candidate).toLowerCase());if(key){const ext=candidate.toLowerCase().split('.').pop(),mime=ext==='webp'?'image/webp':ext==='jpg'||ext==='jpeg'?'image/jpeg':'image/png';artUrl=URL.createObjectURL(new Blob([entries.get(key)],{type:mime}));artFile=candidate;break}}
      const baseId=String(meta.id||meta.name||file.name||'browser-voice').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,50)||'browser-voice';
      const id=`browser:${Date.now()}:${baseId}`,v={
        id,name:String(meta.name||'Browser test voice'),author:String(meta.author||''),description:String(meta.description||''),introSentence:String(meta.introSentence||''),icon:String(meta.icon||''),tags:Array.isArray(meta.tags)?meta.tags:[],artFile,created:meta.created,phonemeSet:meta.phonemeSet||'ARPAbet-39',phonemes:meta.phonemes||P.map(x=>x.c),defaults:meta.defaults||{},sample_count:sampleBytes.size,complete:sampleBytes.size>=39,temporary:true,sourceFile:file.name,_sampleBytes:sampleBytes,_artUrl:artUrl
      };
      // Keep at most a few temporary test packs so the voice selector stays sane.
      const installed=state.voices.filter(x=>!x.temporary),oldTemps=state.voices.filter(x=>x.temporary),temps=oldTemps.slice(0,2);oldTemps.slice(2).forEach(revokeTempArt);state.voices=[v,...temps,...installed];
      renderVoiceOptions();await loadVoice(id);switchTab('synth');
      setBrowserPackStatus(`Loaded “${v.name}” from ${file.name} for this tab only. Nothing was uploaded or installed.`, 'good');
      $('synthMessage').textContent=`Browser test pack loaded: ${v.name}. Use Speak, pitch/speed/overlap, phoneme audition, and Export WAV normally.`;
    }catch(e){console.error(e);setStatus('browser pack failed','bad');setBrowserPackStatus(e.message,'bad');$('synthMessage').textContent=e.message}
    finally{for(const id of ['browserPackImport','browserPackImportVoices']){const el=$(id);if(el)el.value=''}}
  }

  async function fetchVoiceIndex(){
    // Local/dev mode: server.py exposes api/voices.
    // Static-host mode: build_static.py generates mainvoices/voices.json.
    const candidates=['api/voices','mainvoices/voices.json'];
    const errors=[];
    for(const url of candidates){
      try{
        const r=await fetch(url,{cache:'no-store'});
        if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);
        const data=await r.json();
        if(!data||!Array.isArray(data.voices))throw new Error('invalid voice index');
        return {data,source:url};
      }catch(e){errors.push(`${url}: ${e.message}`)}
    }
    throw new Error('Could not load the voice index. Local mode: run server.py. Static mode: run build-static.bat first. '+errors.join(' | '));
  }
  async function scanVoices(){
    try{
      setStatus('scanning mainvoices','busy');const {data,source}=await fetchVoiceIndex();const temp=state.voices.filter(v=>v.temporary);state.voices=[...temp,...(data.voices||[])];renderVoiceOptions();
      if(!state.voices.length){setStatus('no voices installed','bad');$('voiceSelect').innerHTML='<option value="">No voices installed</option>';$('voiceInfo').innerHTML=source.includes('voices.json')?'This static build contains no bundled voices yet. You can still use <b>Test a MainVoice ZIP</b> above.':'Build a pack with <b>MainPack Setup</b>, unzip it into <code>mainvoices/</code>, or test an exported ZIP directly in the browser.';return}
      const wanted=localStorage.getItem('mainvoice.lastVoice'),pick=state.voices.find(v=>v.id===wanted&&!v.temporary)||state.voices[0];await loadVoice(pick.id);
    }catch(e){setStatus('voice scan failed','bad');$('voiceInfo').textContent=e.message;$('voiceList').innerHTML=`<div class="notice bad">${esc(e.message)}</div>`}
  }
  function renderVoiceOptions(){
    const sel=$('voiceSelect'),list=$('voiceList');sel.innerHTML='';list.innerHTML='';
    for(const v of state.voices){
      const o=document.createElement('option');o.value=v.id;o.textContent=voiceLabel(v)+(v.author?` — ${v.author}`:'')+(v.temporary?' [browser test]':'');o.selected=state.voice?.id===v.id;sel.appendChild(o);
      const b=document.createElement('button'),art=voiceArtUrl(v);b.className='voice-option'+(state.voice?.id===v.id?' active':'')+(art?'':' no-art');const tags=voiceTags(v),copy=`<div class="voice-option-copy"><b>${v.icon?`<span class="voice-icon">${esc(v.icon)}</span>`:''}${esc(v.name)}${v.temporary?'<span class="temporary-badge">BROWSER TEST</span>':''}</b><span class="${v.temporary?'temp-line':''}">${esc(v.author||'no author')} · ${v.complete?39:v.sample_count}/39 samples${v.description?' · '+esc(v.description):''}</span>${tags.length?`<div class="voice-tags">${tags.map(t=>`<span class="voice-tag">${esc(t)}</span>`).join('')}</div>`:''}</div>`;b.innerHTML=art?`<img class="voice-option-thumb" src="${esc(art)}" alt=""><div>${copy}</div>`:copy;b.onclick=()=>loadVoice(v.id);list.appendChild(b);
    }
  }
  function applyIntro(v){
    const intro=String(v?.introSentence||'').trim();if(!intro)return;$('textInput').value=intro;state.manual=false;buildPronunciation();
  }
  async function loadVoice(id){
    const v=state.voices.find(x=>x.id===id);if(!v)return;setStatus(`loading ${v.name}`,'busy');document.body.classList.add('loading');stopPlayback();
    try{
      const ctx=getAudioCtx();let pairs;
      if(v.temporary&&v._sampleBytes){pairs=await Promise.all(P.map(async p=>{const ab=v._sampleBytes.get(p.c);if(!ab)return[p.c,null];try{return[p.c,await ctx.decodeAudioData(ab.slice(0))]}catch{return[p.c,null]}}))}
      else{pairs=await Promise.all(P.map(async p=>{const url=`${v.base_url}/samples/${p.c}.wav`;try{const r=await fetch(url,{cache:'no-store'});if(!r.ok)return[p.c,null];const ab=await r.arrayBuffer(),buf=await ctx.decodeAudioData(ab.slice(0));return[p.c,buf]}catch{return[p.c,null]}}))}
      state.buffers=new Map(pairs.filter(x=>x[1]));state.voice=v;if(!v.temporary)localStorage.setItem('mainvoice.lastVoice',v.id);$('voiceSelect').value=v.id;applyIntro(v);applyVoiceDefaults(v.defaults||{});renderVoiceInfo();renderVoiceOptions();renderBank();setStatus(`${v.name} ready`);state.rendered=null;
    }catch(e){setStatus('voice load failed','bad');$('voiceInfo').textContent=e.message}finally{document.body.classList.remove('loading')}
  }
  function applyVoiceDefaults(d){if(Number.isFinite(d.speed))$('speed').value=d.speed;if(Number.isFinite(d.pitchSemitones))$('pitch').value=d.pitchSemitones;if(Number.isFinite(d.overlapMs))$('overlap').value=d.overlapMs;if(Number.isFinite(d.wordGapMs))$('wordGap').value=d.wordGapMs;if(Number.isFinite(d.punctuationGapMs))$('punctGap').value=d.punctuationGapMs;['speed','pitch','overlap','wordGap','punctGap','gain'].forEach(id=>$(id).dispatchEvent(new Event('input')));buildPronunciation()}
  function renderVoiceInfo(){
    const v=state.voice;if(!v)return;const tags=voiceTags(v),intro=String(v.introSentence||'').trim(),art=voiceArtUrl(v);
    const identity=`<div class="voice-title">${v.icon?`<span class="voice-icon">${esc(v.icon)}</span>`:''}${esc(v.name)}${v.temporary?'<span class="temporary-badge">BROWSER TEST</span>':''}</div><div class="voice-meta">${v.author?`by ${esc(v.author)} · `:''}${state.buffers.size}/39 samples loaded${v.description?`<br>${esc(v.description)}`:''}${v.temporary?`<br><b>Temporary:</b> loaded from ${esc(v.sourceFile||'a ZIP')} and removed on refresh.`:''}</div>${tags.length?`<div class="voice-tags">${tags.map(t=>`<span class="voice-tag">${esc(t)}</span>`).join('')}</div>`:''}`;
    $('voiceInfo').className='';$('voiceInfo').innerHTML=art?`<div class="voice-character-card"><img class="voice-character-art" src="${esc(art)}" alt="Character art for ${esc(v.name)}"><div class="voice-character-copy">${identity}${intro?`<div class="divider"></div><div class="small"><b>Intro:</b> ${esc(intro)}</div><button id="reloadIntroBtn" class="button secondary" style="margin-top:9px">↻ Put intro in text box</button>`:''}</div></div>`:`${identity}${intro?`<div class="divider"></div><div class="small"><b>Intro:</b> ${esc(intro)}</div><button id="reloadIntroBtn" class="button secondary" style="margin-top:9px">↻ Put intro in text box</button>`:''}`;
    $('bankTitle').textContent=v.name+' phoneme bank';const btn=$('reloadIntroBtn');if(btn)btn.onclick=()=>{applyIntro(v);switchTab('synth')};
  }
  function renderBank(){const r=$('bankAudition'),q=$('bankSearch').value.trim().toLowerCase();r.innerHTML='';for(const p of P){if(q&&!(`${p.c} ${p.w}`.toLowerCase().includes(q)))continue;const b=document.createElement('button');b.disabled=!state.buffers.has(p.c);b.innerHTML=`<b>${p.c}</b><span>${p.w}</span>`;b.title=state.buffers.has(p.c)?`Play ${p.c} (${p.w})`:'Missing sample';b.onclick=()=>playRaw(p.c);r.appendChild(b)}}
  async function playRaw(code){stopPlayback();const buf=state.buffers.get(code);if(!buf)return;const ctx=getAudioCtx(),s=ctx.createBufferSource();s.buffer=buf;s.connect(ctx.destination);s.start();state.currentSource=s;s.onended=()=>{if(state.currentSource===s)state.currentSource=null}}

  function bindRange(id,out,fmt,rebuild=false){const el=$(id),o=$(out),upd=()=>{o.textContent=fmt(+el.value);state.rendered=null;if(rebuild)buildPronunciation()};el.oninput=upd;upd()}
  let textTimer=0;$('textInput').addEventListener('input',()=>{state.manual=false;clearTimeout(textTimer);textTimer=setTimeout(buildPronunciation,100)});
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));$('voiceSelect').onchange=e=>loadVoice(e.target.value);$('speakBtn').onclick=speak;$('stopBtn').onclick=stopPlayback;$('exportWavBtn').onclick=exportWav;$('refreshPronBtn').onclick=()=>{state.manual=false;buildPronunciation()};$('bankSearch').oninput=renderBank;$('useAdvancedBtn').onclick=()=>{state.active=$('advancedInput').value.trim();state.manual=true;$('phonemePreview').textContent=state.active||'—';state.rendered=null;switchTab('synth');$('synthMessage').textContent='Using your manual ARPAbet pronunciation.'};$('resetAdvancedBtn').onclick=()=>{state.manual=false;buildPronunciation()};for(const id of ['browserPackImport','browserPackImportVoices']){const el=$(id);if(el)el.onchange=e=>importBrowserPack(e.target.files?.[0])}
  for(const ev of ['dragenter','dragover'])document.addEventListener(ev,e=>{if([...e.dataTransfer?.items||[]].some(i=>i.kind==='file')){e.preventDefault();document.body.classList.add('drop-ready')}});for(const ev of ['dragleave','drop'])document.addEventListener(ev,e=>{if(ev==='drop'){e.preventDefault();const f=[...e.dataTransfer.files].find(x=>x.name.toLowerCase().endsWith('.zip'));if(f)importBrowserPack(f)}document.body.classList.remove('drop-ready')});
  bindRange('speed','speedVal',v=>v.toFixed(2)+'×');bindRange('pitch','pitchVal',v=>(v>0?'+':'')+v+' st');bindRange('overlap','overlapVal',v=>Math.round(v)+' ms');bindRange('wordGap','wordGapVal',v=>Math.round(v)+' ms',true);bindRange('punctGap','punctGapVal',v=>Math.round(v)+' ms',true);bindRange('gain','gainVal',v=>(v>0?'+':'')+v+' dB');

  (async()=>{try{await loadDictionary();buildPronunciation();await scanVoices()}catch(e){console.error(e);setStatus('startup failed','bad');$('synthMessage').textContent=e.message}})();
})();
