(() => {
  'use strict';
  const P = window.PHONEMES, PM = window.PHONEME_MAP;
  const $ = id => document.getElementById(id);
  const state = {voices:[],voice:null,buffers:new Map(),dict:null,audioCtx:null,currentSource:null,generated:'',active:'',manual:false,unknown:[],rendered:null,autoTokens:[],words:[],emphasis:new Set(),variationSeed:1};

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
  const VOWELS=new Set(P.filter(x=>x.type==='vowel').map(x=>x.c));
  function dictPronDetailed(word){
    const key=word.toLowerCase();let v=state.dict?.[key];if(!v&&key.endsWith("'s"))v=state.dict?.[key.slice(0,-2)];if(!v)return null;
    return v.map(raw=>{const m=String(raw).match(/^([A-Z]+)([012])?$/);return {code:m?m[1]:String(raw).replace(/[012]$/,''),stress:m&&m[2]?+m[2]:0}});
  }
  function dictPron(word){const d=dictPronDetailed(word);return d?d.map(x=>x.code):null}
  function fallbackPron(word){
    let s=word.toLowerCase().replace(/[^a-z]/g,'');if(!s)return[];
    const out=[];const vowel={a:'AE',e:'EH',i:'IH',o:'AA',u:'AH',y:'IY'};const one={b:'B',c:'K',d:'D',f:'F',g:'G',h:'HH',j:'JH',k:'K',l:'L',m:'M',n:'N',p:'P',q:'K',r:'R',s:'S',t:'T',v:'V',w:'W',x:null,z:'Z'};
    const rules=[['tion',['SH','AH','N']],['sion',['ZH','AH','N']],['tch',['CH']],['dge',['JH']],['igh',['AY']],['eigh',['EY']],['ch',['CH']],['sh',['SH']],['th',['TH']],['ph',['F']],['ng',['NG']],['wh',['W']],['qu',['K','W']],['ck',['K']],['ee',['IY']],['ea',['IY']],['oo',['UW']],['oi',['OY']],['oy',['OY']],['ai',['EY']],['ay',['EY']],['ow',['AW']],['ou',['AW']],['er',['ER']],['ir',['ER']],['ur',['ER']],['ar',['AA','R']],['or',['AO','R']]];
    for(let i=0;i<s.length;){let matched=false;for(const [pat,ph] of rules){if(s.startsWith(pat,i)){out.push(...ph);i+=pat.length;matched=true;break}}if(matched)continue;const c=s[i];if(c==='x'){out.push('K','S');i++;continue}if(vowel[c]){if(c==='e'&&i===s.length-1&&s.length>2){i++;continue}out.push(vowel[c]);i++;continue}if(one[c])out.push(one[c]);i++}
    return out;
  }
  function fallbackDetailed(word){
    const phones=fallbackPron(word);let stressed=false;
    return phones.map(code=>{const stress=!stressed&&VOWELS.has(code)?(stressed=true,1):0;return {code,stress}});
  }
  function wordPron(word){const d=dictPronDetailed(word);const detailed=d||fallbackDetailed(word);return {phones:detailed.map(x=>x.code),detailed,unknown:!d}}
  function tokenizeText(text){return text.match(/[A-Za-z]+(?:'[A-Za-z]+)?|\d+|[.,!?;:…]+|[-–—]/g)||[]}
  function buildPronunciation(){
    if(!state.dict)return;
    const text=$('textInput').value.trim(),toks=tokenizeText(text),parts=[],unknown=[],rich=[],wordList=[];let words=0,phones=0,lastWasWord=false,sentenceIndex=0;
    const addWord=(spoken,display,autoEmphasis=false)=>{
      const p=wordPron(spoken),wordIndex=words;
      if(lastWasWord){parts.push('/');rich.push({type:'word',wordIndex})}
      parts.push(...p.phones);
      wordList.push({index:wordIndex,text:display||spoken,spoken,autoEmphasis});
      p.detailed.forEach((ph,i)=>rich.push({type:'phone',code:ph.code,stress:ph.stress||0,wordIndex,word:spoken,phoneIndex:i,phoneCount:p.detailed.length,sentenceIndex,autoEmphasis}));
      phones+=p.phones.length;words++;if(p.unknown)unknown.push(display||spoken);lastWasWord=true;
    };
    for(const tok of toks){
      if(/^\d+$/.test(tok)){for(const w of numberWords(tok).split(/\s+/))addWord(w,w,false);continue}
      if(/^[A-Za-z]/.test(tok)){const caps=tok.length>1&&tok===tok.toUpperCase()&&/[A-Z]/.test(tok);addWord(tok,tok,caps);continue}
      if(/[.!?…]/.test(tok)){
        const ms=+$('punctGap').value;parts.push(`|${ms}|`);rich.push({type:'pause',ms,mark:tok,sentenceEnd:true});sentenceIndex++;lastWasWord=false;
      }else if(/[,;:]/.test(tok)){
        const ms=Math.round(+$('punctGap').value*.55);parts.push(`|${ms}|`);rich.push({type:'pause',ms,mark:tok,phraseBreak:true});lastWasWord=false;
      }else if(/[-–—]/.test(tok)){
        const ms=Math.round(+$('wordGap').value*1.5);parts.push(`|${ms}|`);rich.push({type:'pause',ms,mark:tok,phraseBreak:true});lastWasWord=false;
      }
    }
    state.generated=parts.join(' ').replace(/\s+\|/g,' |').replace(/\|\s+/g,'| ').trim();if(!state.manual)state.active=state.generated;state.unknown=unknown;state.autoTokens=rich;state.words=wordList;
    state.emphasis=new Set([...state.emphasis].filter(i=>i<wordList.length));
    $('advancedInput').value=state.active;$('phonemePreview').textContent=state.active||'—';renderAnalysis(words,phones,unknown);renderEmphasisWords();state.rendered=null;
  }
  function renderAnalysis(words,phones,unknown){const r=$('analysisStrip');r.innerHTML='';const add=(txt,warn=false)=>{const s=document.createElement('span');s.className='chip'+(warn?' warn':'');s.textContent=txt;r.appendChild(s)};add(`${words} word${words===1?'':'s'}`);add(`${phones} phoneme${phones===1?'':'s'}`);if(unknown.length)add(`${unknown.length} fallback: ${[...new Set(unknown)].slice(0,4).join(', ')}${unknown.length>4?'…':''}`,true);else add('dictionary pronunciation ✓')}

  function parseSequence(seq){
    const raw=seq.toUpperCase().match(/\|\d+\||\/|[A-Z]{1,3}[012]?/g)||[],tokens=[],bad=[];let wordIndex=0;
    for(const x of raw){
      if(x==='/'){tokens.push({type:'word',wordIndex});wordIndex++}
      else if(/^\|\d+\|$/.test(x)){tokens.push({type:'pause',ms:+x.slice(1,-1),mark:'',sentenceEnd:+x.slice(1,-1)>=220})}
      else{const m=x.match(/^([A-Z]{1,3})([012])?$/),c=m?m[1]:x.replace(/[012]$/,'');if(PM[c])tokens.push({type:'phone',code:c,stress:m&&m[2]?+m[2]:0,wordIndex});else bad.push(c)}
    }return {tokens,bad}
  }
  function synthesisSettings(){return {speed:+$('speed').value,pitch:+$('pitch').value,overlap:+$('overlap').value,wordGap:+$('wordGap').value,punctGap:+$('punctGap').value,gainDb:+$('gain').value,expression:$('expressionPreset')?.value||'natural',expressionAmount:(+$('expressionAmount')?.value||0)/100,intonation:(+$('intonation')?.value||100)/100,rhythm:(+$('rhythm')?.value||100)/100,humanize:(+$('humanize')?.value||0)/100,autoStress:$('autoStress')?.checked!==false,smartOverlap:$('smartOverlap')?.checked!==false,autoPunctuation:$('autoPunctuation')?.checked!==false}}

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

  const EXPRESSIONS={
    neutral:{basePitch:0,decline:.15,stressPitch:.20,stressLength:.04,questionRise:.45,exclaimLift:.20,finalLength:.04,tempo:1,energy:0,tone:0,rhythm:.04},
    natural:{basePitch:0,decline:1.05,stressPitch:.70,stressLength:.12,questionRise:2.35,exclaimLift:.85,finalLength:.14,tempo:1,energy:0,tone:0,rhythm:.18},
    friendly:{basePitch:.35,decline:.75,stressPitch:.95,stressLength:.13,questionRise:2.70,exclaimLift:.75,finalLength:.12,tempo:1.01,energy:.35,tone:.8,rhythm:.22},
    excited:{basePitch:.85,decline:.95,stressPitch:1.35,stressLength:.10,questionRise:3.20,exclaimLift:1.55,finalLength:.08,tempo:1.08,energy:1.0,tone:1.4,rhythm:.30},
    calm:{basePitch:-.35,decline:.50,stressPitch:.40,stressLength:.15,questionRise:1.35,exclaimLift:.30,finalLength:.19,tempo:.90,energy:-.45,tone:-.8,rhythm:.10},
    dramatic:{basePitch:-.05,decline:1.55,stressPitch:1.55,stressLength:.23,questionRise:3.00,exclaimLift:1.35,finalLength:.24,tempo:.93,energy:.55,tone:.35,rhythm:.34},
    storyteller:{basePitch:.10,decline:1.20,stressPitch:1.05,stressLength:.18,questionRise:2.65,exclaimLift:1.00,finalLength:.18,tempo:.96,energy:.25,tone:.45,rhythm:.27},
    deadpan:{basePitch:-.10,decline:.08,stressPitch:.08,stressLength:.03,questionRise:.18,exclaimLift:.05,finalLength:.04,tempo:.97,energy:-.20,tone:-.25,rhythm:.01}
  };
  const FUNCTION_WORDS=new Set(['a','an','the','and','or','but','if','of','to','for','in','on','at','by','as','is','are','was','were','be','been','being','it','its','this','that','these','those','i','you','he','she','we','they','my','your','his','her','our','their']);
  function exprProfile(settings){const p=EXPRESSIONS[settings.expression]||EXPRESSIONS.natural,n=EXPRESSIONS.neutral,a=settings.expressionAmount;const o={};for(const k of Object.keys(n))o[k]=n[k]+(p[k]-n[k])*a;return o}
  function hash01(i,salt=0){let x=((i+1)*0x9e3779b1^(state.variationSeed+salt)*0x85ebca6b)>>>0;x^=x>>>16;x=Math.imul(x,0x7feb352d);x^=x>>>15;x=Math.imul(x,0x846ca68b);x^=x>>>16;return (x>>>0)/4294967295}
  function signedNoise(i,salt=0){return hash01(i,salt)*2-1}
  function phoneClass(code){if(SPEECH_SHORT.has(code))return'stop';if(VOWELS.has(code))return'vowel';if(SPEECH_GLIDE.has(code))return'glide';if(SPEECH_FRICATIVE.has(code))return'fricative';if(SPEECH_NASAL.has(code))return'nasal';return'other'}
  function smartOverlapSeconds(a,b,baseMs,enabled=true){
    if(!enabled||!a||!b)return Math.max(0,baseMs)/1000;
    const A=phoneClass(a),B=phoneClass(b),base=Math.max(0,baseMs)/1000;let mul=1,cap=.060;
    if(A==='stop'||B==='stop'){mul=.28;cap=.010}
    else if((A==='fricative'&&B==='stop')||(A==='stop'&&B==='fricative')){mul=.34;cap=.012}
    else if(A==='vowel'&&B==='vowel'){mul=1.20;cap=.052}
    else if((A==='vowel'&&(B==='glide'||B==='nasal'))||((A==='glide'||A==='nasal')&&B==='vowel')){mul=1.12;cap=.048}
    else if(A==='fricative'&&B==='fricative'){mul=.72;cap=.030}
    else if(A==='glide'||B==='glide'){mul=1.05;cap=.044}
    return Math.min(cap,base*mul);
  }
  function sentenceInfo(tokens){
    const info=new Map();let sentence=[],phrase=[];
    const ensure=i=>{if(!info.has(i))info.set(i,{});return info.get(i)};
    const finishPhrase=mark=>{if(!phrase.length)return;const count=phrase.length;phrase.forEach((tokenIndex,i)=>Object.assign(ensure(tokenIndex),{phrasePos:count<=1?1:i/(count-1),phraseIndex:i,phraseCount:count,phraseMark:mark||''}));phrase=[]};
    const finishSentence=mark=>{if(!sentence.length)return;const count=sentence.length;sentence.forEach((tokenIndex,i)=>Object.assign(ensure(tokenIndex),{pos:count<=1?1:i/(count-1),index:i,count,endMark:mark||''}));sentence=[]};
    tokens.forEach((tok,i)=>{
      if(tok.type==='phone'){sentence.push(i);phrase.push(i);return}
      if(tok.type!=='pause')return;
      const mark=tok.mark||'',sentenceEnd=tok.sentenceEnd||/[.!?…]/.test(mark)||tok.ms>=220,phraseBreak=sentenceEnd||tok.phraseBreak||/[,;:—–-]/.test(mark);
      if(phraseBreak)finishPhrase(mark);
      if(sentenceEnd)finishSentence(mark);
    });
    finishPhrase('');finishSentence('');return info;
  }
  function nextPhoneCode(tokens,from){for(let i=from+1;i<tokens.length;i++){if(tokens[i].type==='phone')return tokens[i].code;if(tokens[i].type==='pause')return null}return null}
  function previousPhoneCode(tokens,from){for(let i=from-1;i>=0;i--){if(tokens[i].type==='phone')return tokens[i].code;if(tokens[i].type==='pause')return null}return null}
  function prosodyForPhone(tok,tokenIndex,tokens,settings,profile,sInfo,phoneOrdinal){
    const si=sInfo.get(tokenIndex)||{pos:.5,index:phoneOrdinal,count:1,endMark:'',phrasePos:.5,phraseIndex:0,phraseCount:1,phraseMark:''};
    const pos=si.pos??.5,phrasePos=si.phrasePos??.5,mark=settings.autoPunctuation?(si.endMark||''):'',phraseMark=settings.autoPunctuation?(si.phraseMark||''):'';
    const vowel=VOWELS.has(tok.code),stressEnabled=settings.autoStress,primary=stressEnabled&&tok.stress===1,secondary=stressEnabled&&tok.stress===2,word=String(tok.word||'').toLowerCase(),functionWord=stressEnabled&&FUNCTION_WORDS.has(word),manualEmph=state.emphasis.has(tok.wordIndex),autoEmph=!!tok.autoEmphasis,emph=manualEmph||autoEmph;
    const inton=settings.intonation,amount=settings.expressionAmount,rhythm=settings.rhythm;
    const exclaimCount=(mark.match(/!/g)||[]).length,questionCount=(mark.match(/\?/g)||[]).length;

    // Sentence declination + phrase-reset lift. Commas/semicolons now behave like
    // little fresh launches instead of one long pitch ramp through the sentence.
    let pitch=settings.pitch+profile.basePitch*inton+(0.46-pos)*profile.decline*inton;
    if(phrasePos<.22)pitch+=(1-phrasePos/.22)*.24*profile.rhythm*amount*inton;
    if(vowel&&(primary||secondary))pitch+=(primary?profile.stressPitch:profile.stressPitch*.48)*inton;
    if(functionWord&&!emph)pitch-=.14*amount*inton;
    if(emph)pitch+=(vowel?(primary?1.65:1.15):.42)*amount*inton;

    // Declaratives settle; questions rise; exclamations get a brighter final push.
    if(questionCount&&pos>.60){const q=(pos-.60)/.40;pitch+=Math.pow(Math.max(0,q),1.45)*profile.questionRise*(1+.12*Math.min(2,questionCount-1))*inton}
    else if(exclaimCount&&pos>.64){const q=(pos-.64)/.36;pitch+=Math.pow(Math.max(0,q),1.10)*profile.exclaimLift*(1+.15*Math.min(2,exclaimCount-1))*inton}
    else if(mark&&!mark.includes('…')&&pos>.78){pitch-=((pos-.78)/.22)*.42*profile.decline*amount*inton}
    if(mark.includes('…')&&pos>.68)pitch-=((pos-.68)/.32)*.75*amount*inton;
    if(/[,:;]/.test(phraseMark)&&phrasePos>.78)pitch-=((phrasePos-.78)/.22)*.20*amount*inton;

    // Tiny deterministic movement preserves repeatability while avoiding an
    // absolutely identical target on every unit. New Variation changes the seed.
    pitch+=signedNoise(phoneOrdinal,17)*settings.humanize*(.10+.32*profile.rhythm)*inton;

    let durationScale=1;
    if(vowel&&(primary||secondary))durationScale+=profile.stressLength*(primary?1:.48)*rhythm;
    if(functionWord&&!emph)durationScale-=.055*amount*rhythm;
    if(emph)durationScale+=(vowel?.22:.055)*amount*rhythm;
    if(pos>.84)durationScale+=profile.finalLength*((pos-.84)/.16)*rhythm;
    if(phrasePos>.88&&/[,:;]/.test(phraseMark))durationScale+=.045*amount*rhythm;
    if(questionCount&&pos>.82)durationScale+=.04*amount*rhythm;
    if(mark.includes('…')&&pos>.70)durationScale+=.13*((pos-.70)/.30)*amount*rhythm;
    durationScale*=1+signedNoise(phoneOrdinal,29)*settings.humanize*(.015+.045*profile.rhythm)*rhythm;
    durationScale=Math.max(.70,Math.min(1.52,durationScale));

    let gainDb=profile.energy;
    if(vowel&&primary)gainDb+=.45*amount;if(secondary)gainDb+=.20*amount;if(functionWord&&!emph)gainDb-=.25*amount;if(emph)gainDb+=1.35*amount;
    if(exclaimCount&&pos>.72)gainDb+=.55*amount;if(mark.includes('…')&&pos>.72)gainDb-=.35*amount;
    if(SPEECH_SHORT.has(tok.code))gainDb+=.14*amount;
    gainDb+=signedNoise(phoneOrdinal,43)*settings.humanize*.16;
    return {pitch,durationScale,gainDb,position:pos,phrasePosition:phrasePos,endMark:mark,phraseMark,emphasis:emph,prev:previousPhoneCode(tokens,tokenIndex),next:nextPhoneCode(tokens,tokenIndex)};
  }

  function renderEmphasisWords(){
    const box=$('emphasisWords');if(!box)return;box.innerHTML='';
    if(state.manual){box.innerHTML='<span class="small">Word-click emphasis is available in normal text mode. Manual ARPAbet still gets sentence contour and humanization.</span>';return}
    if(!state.words.length){box.innerHTML='<span class="small">Type something above and its words will appear here.</span>';return}
    for(const w of state.words){const b=document.createElement('button');const auto=w.autoEmphasis;b.className='emphasis-word'+(state.emphasis.has(w.index)?' active':'')+(auto?' auto':'');b.textContent=w.text;b.title=auto?'ALL CAPS: automatically emphasized. Click to add/remove extra emphasis.':'Click to emphasize this word';b.onclick=()=>{if(state.emphasis.has(w.index))state.emphasis.delete(w.index);else state.emphasis.add(w.index);state.rendered=null;renderEmphasisWords()};box.appendChild(b)}
  }
  async function renderSpeech(){
    if(!state.voice)throw new Error('Install/select a voice first.');
    const parsed=state.manual?parseSequence(state.active||state.generated):{tokens:state.autoTokens,bad:[]},tokens=parsed.tokens||[];
    if(parsed.bad.length)throw new Error('Unknown phoneme code(s): '+[...new Set(parsed.bad)].join(', '));
    const missing=[...new Set(tokens.filter(t=>t.type==='phone'&&!state.buffers.has(t.code)).map(t=>t.code))];
    if(missing.length)throw new Error('This voice is missing: '+missing.join(', '));
    if(!tokens.some(t=>t.type==='phone'))throw new Error('There are no phonemes to synthesize.');

    const settings=synthesisSettings(),profile=exprProfile(settings),sr=48000,temp=new OfflineAudioContext(1,sr,sr),sInfo=sentenceInfo(tokens),cache=new Map(),events=[];let t=.04,phoneOrdinal=0;
    const gapHuman=(idx,salt)=>1+signedNoise(idx,salt)*settings.humanize*.08*profile.rhythm;
    for(let i=0;i<tokens.length;i++){
      const tok=tokens[i];
      if(tok.type==='word'){const rhythmic=1+(profile.rhythm*.10*settings.expressionAmount*settings.rhythm);t+=(settings.wordGap/1000)*rhythmic*gapHuman(i,61);continue}
      if(tok.type==='pause'){
        let pause=tok.ms/1000;if(settings.autoPunctuation){const mark=tok.mark||'';if(mark.includes('…'))pause*=1.35;if(mark.includes('!'))pause*=.88;if(mark.includes('?'))pause*=1.04;if(/[,;:]/.test(mark))pause*=1+.10*profile.rhythm*settings.rhythm*settings.expressionAmount}
        t+=pause*gapHuman(i,67);continue;
      }
      const pros=prosodyForPhone(tok,i,tokens,settings,profile,sInfo,phoneOrdinal),source=state.buffers.get(tok.code);
      const sourceScale=Math.min(1.25,Math.max(.82,pros.durationScale));
      const maxSourceSeconds=Math.min(source.duration,speechMaxSourceSeconds(tok.code)*sourceScale);
      const localSpeed=Math.max(.35,Math.min(3.2,settings.speed*profile.tempo/pros.durationScale));
      const pitchQ=Math.round(pros.pitch*20)/20,speedQ=Math.round(localSpeed*100)/100,maxQ=Math.round(maxSourceSeconds*1000)/1000,key=`${tok.code}|${pitchQ}|${speedQ}|${maxQ}`;
      let buf=cache.get(key);if(!buf){buf=MainVoiceDSP.toAudioBuffer(temp,source,{pitchSemitones:pitchQ,speed:speedQ,maxSourceSeconds:maxQ});cache.set(key,buf)}
      const pairOverlap=smartOverlapSeconds(tok.code,pros.next,settings.overlap,settings.smartOverlap),ov=Math.min(pairOverlap,buf.duration*.55);
      events.push({code:tok.code,when:t,buffer:buf,overlap:ov,gainDb:pros.gainDb,pitch:pitchQ,emphasis:pros.emphasis});
      t+=Math.max(.014,buf.duration-ov);phoneOrdinal++;
    }

    const total=t+.08,length=Math.max(1,Math.ceil(total*sr)),off=new OfflineAudioContext(1,length,sr),master=off.createGain(),tone=off.createBiquadFilter(),compressor=off.createDynamicsCompressor();
    master.gain.value=Math.pow(10,settings.gainDb/20);tone.type='highshelf';tone.frequency.value=2600;tone.gain.value=profile.tone*settings.expressionAmount;
    compressor.threshold.value=-8;compressor.knee.value=8;compressor.ratio.value=3;compressor.attack.value=.004;compressor.release.value=.12;master.connect(tone);tone.connect(compressor);compressor.connect(off.destination);
    for(const ev of events){
      const src=off.createBufferSource(),g=off.createGain();src.buffer=ev.buffer;src.connect(g);g.connect(master);const dur=src.buffer.duration,cross=Math.min(Math.max(.0025,ev.overlap*.55),.024,dur*.28),peak=Math.pow(10,ev.gainDb/20);
      g.gain.setValueAtTime(0,ev.when);g.gain.linearRampToValueAtTime(peak,ev.when+cross);g.gain.setValueAtTime(peak,Math.max(ev.when+cross,ev.when+dur-cross));g.gain.linearRampToValueAtTime(0,ev.when+dur);src.start(ev.when);
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
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));$('voiceSelect').onchange=e=>loadVoice(e.target.value);$('speakBtn').onclick=speak;$('stopBtn').onclick=stopPlayback;$('exportWavBtn').onclick=exportWav;$('refreshPronBtn').onclick=()=>{state.manual=false;buildPronunciation()};$('bankSearch').oninput=renderBank;$('useAdvancedBtn').onclick=()=>{state.active=$('advancedInput').value.trim();state.manual=true;$('phonemePreview').textContent=state.active||'—';state.rendered=null;renderEmphasisWords();switchTab('synth');$('synthMessage').textContent='Using your manual ARPAbet pronunciation. Expression still applies, but automatic word stress is limited unless you include ARPAbet stress digits.'};$('resetAdvancedBtn').onclick=()=>{state.manual=false;buildPronunciation()};for(const id of ['browserPackImport','browserPackImportVoices']){const el=$(id);if(el)el.onchange=e=>importBrowserPack(e.target.files?.[0])}
  for(const ev of ['dragenter','dragover'])document.addEventListener(ev,e=>{if([...e.dataTransfer?.items||[]].some(i=>i.kind==='file')){e.preventDefault();document.body.classList.add('drop-ready')}});for(const ev of ['dragleave','drop'])document.addEventListener(ev,e=>{if(ev==='drop'){e.preventDefault();const f=[...e.dataTransfer.files].find(x=>x.name.toLowerCase().endsWith('.zip'));if(f)importBrowserPack(f)}document.body.classList.remove('drop-ready')});
  bindRange('speed','speedVal',v=>v.toFixed(2)+'×');bindRange('pitch','pitchVal',v=>(v>0?'+':'')+v+' st');bindRange('overlap','overlapVal',v=>Math.round(v)+' ms');bindRange('wordGap','wordGapVal',v=>Math.round(v)+' ms',true);bindRange('punctGap','punctGapVal',v=>Math.round(v)+' ms',true);bindRange('gain','gainVal',v=>(v>0?'+':'')+v+' dB');
  bindRange('expressionAmount','expressionAmountVal',v=>Math.round(v)+'%');bindRange('intonation','intonationVal',v=>Math.round(v)+'%');bindRange('rhythm','rhythmVal',v=>Math.round(v)+'%');bindRange('humanize','humanizeVal',v=>Math.round(v)+'%');
  function saveExpressionPrefs(){try{localStorage.setItem('mainvoice.expression',JSON.stringify({preset:$('expressionPreset').value,amount:+$('expressionAmount').value,intonation:+$('intonation').value,rhythm:+$('rhythm').value,humanize:+$('humanize').value,autoStress:$('autoStress').checked,smartOverlap:$('smartOverlap').checked,autoPunctuation:$('autoPunctuation').checked}))}catch{}state.rendered=null}
  function loadExpressionPrefs(){try{const p=JSON.parse(localStorage.getItem('mainvoice.expression')||'null');if(!p)return;if(p.preset&&EXPRESSIONS[p.preset])$('expressionPreset').value=p.preset;if(Number.isFinite(p.amount))$('expressionAmount').value=p.amount;if(Number.isFinite(p.intonation))$('intonation').value=p.intonation;if(Number.isFinite(p.rhythm))$('rhythm').value=p.rhythm;if(Number.isFinite(p.humanize))$('humanize').value=p.humanize;if(typeof p.autoStress==='boolean')$('autoStress').checked=p.autoStress;if(typeof p.smartOverlap==='boolean')$('smartOverlap').checked=p.smartOverlap;if(typeof p.autoPunctuation==='boolean')$('autoPunctuation').checked=p.autoPunctuation}catch{}}
  for(const id of ['expressionPreset','expressionAmount','intonation','rhythm','humanize','autoStress','smartOverlap','autoPunctuation'])$(id)?.addEventListener('input',()=>{saveExpressionPrefs();if(id==='expressionAmount')$('expressionAmountVal').textContent=Math.round(+$('expressionAmount').value)+'%';if(id==='intonation')$('intonationVal').textContent=Math.round(+$('intonation').value)+'%';if(id==='rhythm')$('rhythmVal').textContent=Math.round(+$('rhythm').value)+'%';if(id==='humanize')$('humanizeVal').textContent=Math.round(+$('humanize').value)+'%'});
  $('newVariationBtn').onclick=()=>{state.variationSeed=(state.variationSeed%9999)+1;$('variationVal').textContent='#'+state.variationSeed;state.rendered=null;$('synthMessage').textContent='New deterministic micro-variation ready. Same words, slightly different timing/pitch details.'};
  $('clearEmphasisBtn').onclick=()=>{state.emphasis.clear();renderEmphasisWords();state.rendered=null};
  loadExpressionPrefs();['expressionAmount','intonation','rhythm','humanize'].forEach(id=>$(id).dispatchEvent(new Event('input')));$('variationVal').textContent='#'+state.variationSeed;

  (async()=>{try{await loadDictionary();buildPronunciation();await scanVoices()}catch(e){console.error(e);setStatus('startup failed','bad');$('synthMessage').textContent=e.message}})();
})();
