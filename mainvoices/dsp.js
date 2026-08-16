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
    const speed=clamp(+options.speed||1,0.25,4);
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

  function toAudioBuffer(context, inputBuffer, options={}){
    const mono=inputBuffer.getChannelData(0);
    const data=transform(mono,inputBuffer.sampleRate,context.sampleRate,options);
    const buf=context.createBuffer(1,data.length,context.sampleRate);
    buf.copyToChannel(data,0);
    return buf;
  }

  return {transform,toAudioBuffer,resampleLinear,wsola};
});
