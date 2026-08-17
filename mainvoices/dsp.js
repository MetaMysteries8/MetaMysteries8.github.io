/* MainVoice DSP — independent pitch + duration using a small WSOLA time stretcher.
   No external dependencies. Designed for short mono phoneme samples. */
(function(root, factory){
  const api = factory();
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  if(root) root.MainVoiceDSP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

  function interp(x, pos){
    if(pos<=0) return x[0] || 0;
    const last=x.length-1;
    if(pos>=last) return x[last] || 0;
    const i=pos|0, f=pos-i;
    return x[i] + (x[i+1]-x[i])*f;
  }

  function resampleLinear(input, newLength){
    newLength=Math.max(1,Math.round(newLength));
    if(newLength===input.length) return input.slice();
    const out=new Float32Array(newLength);
    if(input.length===1){out.fill(input[0]);return out;}
    const scale=(input.length-1)/Math.max(1,newLength-1);
    for(let i=0;i<newLength;i++) out[i]=interp(input,i*scale);
    return out;
  }

  function hann(n){
    const w=new Float32Array(n), den=Math.max(1,n-1);
    for(let i=0;i<n;i++) w[i]=0.5-0.5*Math.cos(2*Math.PI*i/den);
    return w;
  }

  // Waveform-similarity overlap-add. This changes duration while keeping the
  // local waveform period (and therefore pitch) approximately unchanged.
  function wsola(input, stretch, sampleRate, wantedLength){
    wantedLength=Math.max(1,Math.round(wantedLength));
    if(input.length<32 || wantedLength<32) return resampleLinear(input,wantedLength);
    if(Math.abs(stretch-1)<0.002){
      const out=new Float32Array(wantedLength);
      out.set(input.subarray(0,Math.min(input.length,wantedLength)));
      if(wantedLength>input.length){
        const tail=input[input.length-1]||0;
        for(let i=input.length;i<wantedLength;i++) out[i]=tail;
      }
      return out;
    }

    const seconds=input.length/sampleRate;
    const frameMs=seconds<0.09?14:seconds<0.18?22:40;
    const hopMs=seconds<0.09?4:seconds<0.18?6:10;
    const searchMs=seconds<0.09?2.5:seconds<0.18?4:8;
    let frame=Math.max(48,Math.round(sampleRate*frameMs/1000));
    if(frame%2) frame++;
    frame=Math.min(frame,Math.max(48,input.length));
    const synthHop=Math.max(16,Math.round(sampleRate*hopMs/1000));
    const analysisHop=synthHop/Math.max(0.05,stretch);
    const search=Math.max(4,Math.round(sampleRate*searchMs/1000));
    const overlap=Math.max(8,frame-synthHop);
    const win=hann(frame);
    const out=new Float32Array(wantedLength+frame);
    const norm=new Float32Array(wantedLength+frame);
    let prevFrame=null, inPos=0, outPos=0, frameNo=0;

    while(outPos<wantedLength){
      let best=0;
      if(frameNo===0){
        best=0;
      }else{
        const expected=inPos+analysisHop;
        const maxStart=Math.max(0,input.length-frame);
        const lo=Math.max(0,Math.floor(expected-search));
        const hi=Math.min(maxStart,Math.ceil(expected+search));
        best=clamp(Math.round(expected),0,maxStart);

        // Compare the tail of the previous frame to candidate heads. A coarse
        // search is intentional: it is fast enough for interactive browser TTS.
        const refStart=Math.min(synthHop,Math.max(0,frame-overlap));
        const corrStride=Math.max(1,Math.floor(overlap/96));
        const searchStride=Math.max(1,Math.round(sampleRate/12000));
        let refEnergy=1e-9;
        for(let j=0;j<overlap;j+=corrStride){const v=prevFrame[refStart+j]||0;refEnergy+=v*v;}
        let bestScore=-Infinity;
        for(let cand=lo;cand<=hi;cand+=searchStride){
          let dot=0,e=1e-9;
          for(let j=0;j<overlap;j+=corrStride){
            const a=prevFrame[refStart+j]||0,b=input[cand+j]||0;
            dot+=a*b;e+=b*b;
          }
          const score=dot/Math.sqrt(refEnergy*e);
          if(score>bestScore){bestScore=score;best=cand;}
        }
      }

      const current=new Float32Array(frame);
      const available=Math.min(frame,input.length-best);
      if(available>0) current.set(input.subarray(best,best+available));
      const end=Math.min(out.length,outPos+frame),n=end-outPos;
      for(let j=0;j<n;j++){
        const w=win[j];out[outPos+j]+=current[j]*w;norm[outPos+j]+=w;
      }
      prevFrame=current;inPos=best;outPos+=synthHop;frameNo++;
      if(frameNo>2000) break;
    }

    const result=out.subarray(0,wantedLength);
    for(let i=0;i<result.length;i++) if(norm[i]>1e-5) result[i]/=norm[i];
    return result.slice();
  }

  /**
   * Transform a mono sample while controlling pitch and speed independently.
   * pitchSemitones changes pitch only. speed changes duration only.
   */
  function transform(input, inputRate, outputRate, options={}){
    if(!(input instanceof Float32Array)) input=new Float32Array(input);
    inputRate=Math.max(8000,+inputRate||48000);outputRate=Math.max(8000,+outputRate||inputRate);
    const pitch=clamp(+options.pitchSemitones||0,-24,24);
    const speed=clamp(+options.speed||1,0.08,8);
    const maxSeconds=Number.isFinite(options.maxSourceSeconds)?Math.max(0.005,+options.maxSourceSeconds):Infinity;
    const sourceLength=Math.max(1,Math.min(input.length,Math.round(maxSeconds*inputRate)));
    const source=input.subarray(0,sourceLength);
    const sourceSeconds=sourceLength/inputRate;
    const baseLength=Math.max(1,Math.round(sourceSeconds*outputRate));
    const base=resampleLinear(source,baseLength); // sample-rate conversion only
    const ratio=Math.pow(2,pitch/12);
    const pitchedLength=Math.max(1,Math.round(base.length/ratio));
    const pitched=Math.abs(pitch)<0.001?base.slice():resampleLinear(base,pitchedLength);
    const wantedLength=Math.max(1,Math.round(base.length/speed));
    const stretch=wantedLength/Math.max(1,pitched.length);
    let out=(Math.abs(stretch-1)<0.002 && pitched.length===wantedLength)?pitched:wsola(pitched,stretch,outputRate,wantedLength);

    // Tiny edge fade prevents clicks created by slicing/time stretching.
    const fade=Math.min(Math.round(outputRate*0.003),Math.floor(out.length/2));
    for(let i=0;i<fade;i++){
      const g=(i+1)/Math.max(1,fade);out[i]*=g;out[out.length-1-i]*=g;
    }
    return out;
  }

  // Singing sustain: preserve the recorded attack and release once, and stretch
  // only a stable middle region. This avoids the classic bad sampler behavior
  // where a long note repeats the whole phoneme (attack -> body -> release ->
  // attack -> body -> release...). Diphthongs can reserve a longer release so
  // their vowel glide happens once near the end of the note.
  function sustainTransform(input, inputRate, outputRate, options={}){
    if(!(input instanceof Float32Array)) input=new Float32Array(input);
    inputRate=Math.max(8000,+inputRate||48000);outputRate=Math.max(8000,+outputRate||inputRate);
    const pitch=clamp(+options.pitchSemitones||0,-24,24);
    const targetSeconds=Math.max(0.018,+options.targetSeconds||0.1);
    const maxSeconds=Number.isFinite(options.maxSourceSeconds)?Math.max(0.005,+options.maxSourceSeconds):Infinity;
    const sourceLength=Math.max(1,Math.min(input.length,Math.round(maxSeconds*inputRate)));
    const source=input.subarray(0,sourceLength);
    const sourceSeconds=sourceLength/inputRate;

    // Shift pitch first while keeping the natural source duration unchanged.
    const pitched=transform(source,inputRate,outputRate,{pitchSemitones:pitch,speed:1});
    const targetLength=Math.max(1,Math.round(targetSeconds*outputRate));
    const naturalSeconds=pitched.length/outputRate;

    // Short notes are better served by the normal duration-preserving transform.
    // The special sustain path is for actual holds.
    if(targetLength<=pitched.length*1.04 || pitched.length<96){
      const speed=sourceSeconds/targetSeconds;
      return transform(source,inputRate,outputRate,{pitchSemitones:pitch,speed});
    }

    let attackSec=Number.isFinite(options.attackSeconds)?+options.attackSeconds:Math.min(0.075,naturalSeconds*0.20);
    let releaseSec=Number.isFinite(options.releaseSeconds)?+options.releaseSeconds:Math.min(0.065,naturalSeconds*0.18);
    attackSec=clamp(attackSec,0.004,naturalSeconds*0.42);
    releaseSec=clamp(releaseSec,0.004,naturalSeconds*0.42);
    let attackLen=Math.max(8,Math.round(attackSec*outputRate));
    let releaseLen=Math.max(8,Math.round(releaseSec*outputRate));
    if(attackLen+releaseLen>pitched.length-48){
      const scale=Math.max(0.15,(pitched.length-48)/(attackLen+releaseLen));
      attackLen=Math.max(8,Math.floor(attackLen*scale));
      releaseLen=Math.max(8,Math.floor(releaseLen*scale));
    }
    const middleStart=attackLen,middleEnd=Math.max(middleStart+32,pitched.length-releaseLen);
    const attack=pitched.slice(0,middleStart),middle=pitched.slice(middleStart,middleEnd),release=pitched.slice(middleEnd);
    if(middle.length<32 || release.length<4){
      const speed=sourceSeconds/targetSeconds;
      return transform(source,inputRate,outputRate,{pitchSemitones:pitch,speed});
    }

    let fade=Math.round((Number.isFinite(options.crossfadeSeconds)?+options.crossfadeSeconds:0.010)*outputRate);
    fade=Math.max(2,Math.min(fade,Math.floor(attack.length/3),Math.floor(middle.length/3),Math.floor(release.length/3)));
    const middleWanted=Math.max(32,targetLength-attack.length-release.length+fade*2);
    const stretched=wsola(middle,middleWanted/Math.max(1,middle.length),outputRate,middleWanted);
    const outLength=attack.length+stretched.length+release.length-fade*2;
    const out=new Float32Array(outLength);

    // Attack, once.
    out.set(attack,0);
    let pos=attack.length-fade;
    // Attack -> sustain equal-power-ish linear crossfade.
    for(let i=0;i<fade;i++){
      const t=(i+1)/(fade+1),a=out[pos+i],b=stretched[i]||0;
      out[pos+i]=a*(1-t)+b*t;
    }
    out.set(stretched.subarray(fade),pos+fade);
    pos=attack.length+stretched.length-fade*2;
    // Sustain -> release.
    for(let i=0;i<fade;i++){
      const t=(i+1)/(fade+1),a=out[pos+i],b=release[i]||0;
      out[pos+i]=a*(1-t)+b*t;
    }
    out.set(release.subarray(fade),pos+fade);

    // Correct any +/- a few samples of rounding without changing pitch.
    let result=out;
    if(result.length!==targetLength){
      if(Math.abs(result.length-targetLength)<=4){
        const fixed=new Float32Array(targetLength);fixed.set(result.subarray(0,Math.min(result.length,targetLength)));result=fixed;
      }else{
        // Only the middle is allowed to absorb duration correction; never resample
        // the complete attack/release just to fix bookkeeping.
        const desiredMiddle=Math.max(32,targetLength-attack.length-release.length+fade*2);
        const corrected=wsola(middle,desiredMiddle/Math.max(1,middle.length),outputRate,desiredMiddle);
        const fixedLen=attack.length+corrected.length+release.length-fade*2, fixed=new Float32Array(fixedLen);
        fixed.set(attack,0);let p=attack.length-fade;
        for(let i=0;i<fade;i++){const t=(i+1)/(fade+1);fixed[p+i]=fixed[p+i]*(1-t)+(corrected[i]||0)*t;}
        fixed.set(corrected.subarray(fade),p+fade);p=attack.length+corrected.length-fade*2;
        for(let i=0;i<fade;i++){const t=(i+1)/(fade+1);fixed[p+i]=fixed[p+i]*(1-t)+(release[i]||0)*t;}
        fixed.set(release.subarray(fade),p+fade);result=fixed;
      }
    }

    const edge=Math.min(Math.round(outputRate*0.0025),Math.floor(result.length/2));
    for(let i=0;i<edge;i++){const g=(i+1)/Math.max(1,edge);result[i]*=g;result[result.length-1-i]*=g;}
    return result;
  }

  function toAudioBuffer(context, inputBuffer, options={}){
    const mono=inputBuffer.getChannelData(0);
    const data=transform(mono,inputBuffer.sampleRate,context.sampleRate,options);
    const buf=context.createBuffer(1,data.length,context.sampleRate);
    buf.copyToChannel(data,0);
    return buf;
  }

  function sustainToAudioBuffer(context,inputBuffer,options={}){
    const mono=inputBuffer.getChannelData(0);
    const data=sustainTransform(mono,inputBuffer.sampleRate,context.sampleRate,options);
    const buf=context.createBuffer(1,data.length,context.sampleRate);
    buf.copyToChannel(data,0);
    return buf;
  }

  return {transform,sustainTransform,toAudioBuffer,sustainToAudioBuffer,resampleLinear,wsola};
});
