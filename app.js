const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const canvas = $('#mainCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const state = {
  mode:'stencil', source:null, generated:false, zoom:1,
  history:[], redo:[], eraser:false, drawing:false, inverted:false,
  variants:[]
};

const sizes = {
  A4:[210,297], A3:[297,420], A2:[420,594], A1:[594,841], A0:[841,1189]
};

function setStatus(t){ $('#status').textContent=t; }
function showCanvas(){ $('#emptyState').classList.add('hidden'); }
function snapshot(){
  if(!state.generated) return;
  state.history.push(ctx.getImageData(0,0,canvas.width,canvas.height));
  if(state.history.length>20) state.history.shift();
  state.redo=[];
}
function restore(img){ ctx.putImageData(img,0,0); }

$$('.mode-btn').forEach(btn=>btn.addEventListener('click',()=>{
  $$('.mode-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  state.mode=btn.dataset.mode;
  $$('.variant-only').forEach(el=>el.classList.toggle('hidden',state.mode!=='variants'));
  $('#generateBtn').textContent=state.mode==='variants'?'5 Varianten erzeugen':'Schablone erzeugen';
  $('#variantsWrap').classList.toggle('hidden',state.mode!=='variants');
}));

['complexity','density','detail','similarity','randomness'].forEach(id=>{
  const input=$('#'+id), out=$('#'+id+'Out');
  if(input && out) input.addEventListener('input',()=>out.value=input.value);
});

$('#fileInput').addEventListener('change', e=>{
  const f=e.target.files[0]; if(!f) return;
  $('#fileName').textContent=f.name;
  const img=new Image();
  img.onload=()=>{ state.source=img; drawSourcePreview(); URL.revokeObjectURL(img.src); };
  img.src=URL.createObjectURL(f);
});

function fitImage(img,w,h){
  const r=Math.min(w/img.width,h/img.height);
  return {w:img.width*r,h:img.height*r,x:(w-img.width*r)/2,y:(h-img.height*r)/2};
}
function drawSourcePreview(){
  const [mmW,mmH]=sizes[$('#paperSize').value];
  canvas.width=900; canvas.height=Math.round(900*mmH/mmW);
  ctx.fillStyle='white'; ctx.fillRect(0,0,canvas.width,canvas.height);
  const f=fitImage(state.source,canvas.width,canvas.height);
  ctx.drawImage(state.source,f.x,f.y,f.w,f.h);
  showCanvas(); state.generated=false; setStatus('Bild geladen');
}

function luminance(r,g,b){ return .2126*r+.7152*g+.0722*b; }

function processToStencil(seedOffset=0, variation=0){
  if(!state.source) return null;
  const [mmW,mmH]=sizes[$('#paperSize').value];
  const w=700, h=Math.round(w*mmH/mmW);
  const off=document.createElement('canvas'); off.width=w; off.height=h;
  const o=off.getContext('2d',{willReadFrequently:true});
  o.fillStyle='#fff';o.fillRect(0,0,w,h);
  const f=fitImage(state.source,w,h); o.drawImage(state.source,f.x,f.y,f.w,f.h);

  let img=o.getImageData(0,0,w,h), d=img.data;
  const complexity=+$('#complexity').value;
  const density=+$('#density').value;
  const detail=+$('#detail').value;
  const similarity=+$('#similarity').value||70;
  const randomness=+$('#randomness').value||40;

  let threshold=210-(density*1.2);
  threshold += variation*((seedOffset*17)%29-14)*(randomness/100);
  const quant=Math.max(1, Math.round(1+(100-detail)/15));
  const noiseAmp = state.mode==='variants' ? (100-similarity)*.7 + randomness*.35 : 0;

  let gray=new Uint8Array(w*h);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      let lum=luminance(d[i],d[i+1],d[i+2]);
      if(noiseAmp){
        const n = pseudoNoise(x,y,seedOffset)*noiseAmp;
        lum += n;
      }
      gray[y*w+x]=lum;
    }
  }

  // simple box blur; more blur at low complexity
  const radius=Math.max(0,Math.round((100-complexity)/24));
  if(radius>0) gray=boxBlur(gray,w,h,radius);

  // binary
  let mask=new Uint8Array(w*h); // 1 = black material, 0 = cutout
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      let v=gray[y*w+x] < threshold ? 1:0;
      // coarse simplification grid
      if(quant>1 && (x%quant || y%quant)){
        const sx=x-(x%quant), sy=y-(y%quant);
        v=gray[sy*w+sx] < threshold ? 1:0;
      }
      mask[y*w+x]=v;
    }
  }

  // Ensure outer frame as connected stencil material.
  const frame=Math.max(4,Math.round(w*0.012));
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    if(x<frame||y<frame||x>=w-frame||y>=h-frame) mask[y*w+x]=1;
  }

  // Remove tiny black speckles / fill tiny white holes
  mask=majorityPass(mask,w,h,Math.max(1,Math.round((100-detail)/30)));

  // Bridge black islands to connected frame
  const bridgeMm=+$('#bridgeMm').value;
  const pxPerMm=w/mmW;
  const bridgePx=Math.max(3,Math.round(bridgeMm*pxPerMm));
  let report=bridgeBlackIslands(mask,w,h,bridgePx);

  return {mask,w,h,report};
}

function pseudoNoise(x,y,s){
  let n=Math.sin((x*12.9898+y*78.233+(s+1)*37.719))*43758.5453;
  return (n-Math.floor(n))-.5;
}
function boxBlur(src,w,h,r){
  let out=new Uint8Array(src.length);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      let sum=0,c=0;
      for(let yy=Math.max(0,y-r);yy<=Math.min(h-1,y+r);yy++)
        for(let xx=Math.max(0,x-r);xx<=Math.min(w-1,x+r);xx++){sum+=src[yy*w+xx];c++;}
      out[y*w+x]=sum/c;
    }
  }
  return out;
}
function majorityPass(mask,w,h,passes){
  let cur=mask;
  for(let p=0;p<passes;p++){
    const out=cur.slice();
    for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){
      let s=0;
      for(let yy=-1;yy<=1;yy++) for(let xx=-1;xx<=1;xx++) s+=cur[(y+yy)*w+x+xx];
      if(s>=7) out[y*w+x]=1; else if(s<=2) out[y*w+x]=0;
    }
    cur=out;
  }
  return cur;
}

function bridgeBlackIslands(mask,w,h,bridgePx){
  const seen=new Uint8Array(w*h);
  const comps=[];
  const qx=new Int32Array(w*h), qy=new Int32Array(w*h);
  for(let sy=0;sy<h;sy++) for(let sx=0;sx<w;sx++){
    const idx=sy*w+sx;
    if(!mask[idx]||seen[idx]) continue;
    let head=0,tail=0; qx[tail]=sx;qy[tail]=sy;tail++;seen[idx]=1;
    let pts=[],touch=false,sumx=0,sumy=0;
    while(head<tail){
      const x=qx[head],y=qy[head++],i=y*w+x;
      pts.push(i); sumx+=x; sumy+=y;
      if(x===0||y===0||x===w-1||y===h-1) touch=true;
      const nb=[[1,0],[-1,0],[0,1],[0,-1]];
      for(const [dx,dy] of nb){
        const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=w||ny>=h)continue;
        const ni=ny*w+nx;if(mask[ni]&&!seen[ni]){seen[ni]=1;qx[tail]=nx;qy[tail]=ny;tail++;}
      }
    }
    comps.push({pts,touch,cx:sumx/pts.length,cy:sumy/pts.length,size:pts.length});
  }
  const root=comps.filter(c=>c.touch).sort((a,b)=>b.size-a.size)[0];
  let bridged=0, removed=0;
  for(const c of comps){
    if(c.touch) continue;
    if(c.size < bridgePx*bridgePx*.8){
      // tiny island: remove it
      for(const i of c.pts) mask[i]=0;
      removed++; continue;
    }
    // connect to nearest outer border point (stable, deterministic)
    const distances=[
      {d:c.cx, x:0,y:c.cy},
      {d:w-1-c.cx,x:w-1,y:c.cy},
      {d:c.cy,x:c.cx,y:0},
      {d:h-1-c.cy,x:c.cx,y:h-1}
    ].sort((a,b)=>a.d-b.d);
    drawThickLine(mask,w,h,Math.round(c.cx),Math.round(c.cy),Math.round(distances[0].x),Math.round(distances[0].y),bridgePx);
    bridged++;
  }
  return {components:comps.length,bridged,removed};
}

function drawThickLine(mask,w,h,x0,y0,x1,y1,r){
  const steps=Math.max(Math.abs(x1-x0),Math.abs(y1-y0),1);
  const rad=Math.max(1,Math.floor(r/2));
  for(let s=0;s<=steps;s++){
    const t=s/steps, x=Math.round(x0+(x1-x0)*t), y=Math.round(y0+(y1-y0)*t);
    for(let yy=y-rad;yy<=y+rad;yy++) for(let xx=x-rad;xx<=x+rad;xx++){
      if(xx>=0&&yy>=0&&xx<w&&yy<h && (xx-x)*(xx-x)+(yy-y)*(yy-y)<=rad*rad) mask[yy*w+xx]=1;
    }
  }
}

function renderResult(res,target=canvas){
  target.width=res.w; target.height=res.h;
  const c=target.getContext('2d'); const img=c.createImageData(res.w,res.h);
  for(let i=0;i<res.mask.length;i++){
    let black=res.mask[i]===1;
    if(state.inverted) black=!black;
    const v=black?0:255, j=i*4;
    img.data[j]=img.data[j+1]=img.data[j+2]=v;img.data[j+3]=255;
  }
  c.putImageData(img,0,0);
}

$('#generateBtn').addEventListener('click', async ()=>{
  if(!state.source){alert('Bitte zuerst ein Bild hochladen.');return;}
  setStatus('Wird erzeugt …');
  await new Promise(r=>setTimeout(r,30));
  if(state.mode==='stencil'){
    const res=processToStencil();
    renderResult(res); state.generated=true; snapshot(); showCanvas();
    updateValidation(res.report); $('#variantsWrap').classList.add('hidden');
  } else {
    state.variants=[];
    const wrap=$('#variants'); wrap.innerHTML='';
    for(let i=0;i<5;i++){
      const res=processToStencil(i+1,1);
      state.variants.push(res);
      const card=document.createElement('div');card.className='variant-card';
      const c=document.createElement('canvas'); renderResult(res,c); card.appendChild(c);
      card.addEventListener('click',()=>{
        $$('.variant-card').forEach(x=>x.classList.remove('selected'));card.classList.add('selected');
        renderResult(res);state.generated=true;snapshot();updateValidation(res.report);showCanvas();
      });
      wrap.appendChild(card);
    }
    $('#variantsWrap').classList.remove('hidden');
    wrap.firstChild?.click();
  }
  setStatus('Fertig');
});

$('#optimizeBtn').addEventListener('click',()=>{
  if(!state.generated){alert('Bitte zuerst eine Schablone erzeugen.');return;}
  snapshot();
  // Re-run from source using current settings for now.
  const res=processToStencil();
  renderResult(res); updateValidation(res.report); setStatus('Optimiert');
});

function updateValidation(r){
  $('#validationTitle').textContent='Technische Prüfung abgeschlossen';
  $('#validationText').textContent=`Komponenten: ${r.components} · Brücken gesetzt: ${r.bridged} · kleine Inseln entfernt: ${r.removed}`;
}

$('#invertBtn').addEventListener('click',()=>{
  if(!state.generated)return; snapshot(); state.inverted=!state.inverted;
  const img=ctx.getImageData(0,0,canvas.width,canvas.height);
  for(let i=0;i<img.data.length;i+=4){ const v=255-img.data[i];img.data[i]=img.data[i+1]=img.data[i+2]=v; }
  ctx.putImageData(img,0,0);
});
$('#zoomInBtn').addEventListener('click',()=>setZoom(state.zoom+.1));
$('#zoomOutBtn').addEventListener('click',()=>setZoom(state.zoom-.1));
function setZoom(z){state.zoom=Math.min(2,Math.max(.4,z));canvas.style.transform=`scale(${state.zoom})`;$('#zoomLabel').textContent=Math.round(state.zoom*100)+'%';}

$('#eraserBtn').addEventListener('click',()=>{state.eraser=!state.eraser;$('#eraserBtn').classList.toggle('primary',state.eraser);});
canvas.addEventListener('pointerdown',e=>{if(!state.eraser||!state.generated)return;snapshot();state.drawing=true;eraseAt(e);});
canvas.addEventListener('pointermove',e=>{if(state.drawing)eraseAt(e);});
window.addEventListener('pointerup',()=>state.drawing=false);
function eraseAt(e){
  const r=canvas.getBoundingClientRect(), x=(e.clientX-r.left)*canvas.width/r.width, y=(e.clientY-r.top)*canvas.height/r.height;
  ctx.save();ctx.fillStyle='white';ctx.beginPath();ctx.arc(x,y,Math.max(8,canvas.width*.012),0,Math.PI*2);ctx.fill();ctx.restore();
}
$('#undoBtn').addEventListener('click',()=>{
  if(state.history.length<2)return; const current=state.history.pop();state.redo.push(current);restore(state.history[state.history.length-1]);
});
$('#redoBtn').addEventListener('click',()=>{
  if(!state.redo.length)return; const img=state.redo.pop();state.history.push(img);restore(img);
});

$('#exportJpgBtn').addEventListener('click',()=>downloadData(canvas.toDataURL('image/jpeg',.95),'etter-schablone.jpg'));
$('#exportSvgBtn').addEventListener('click',()=>{
  if(!state.generated)return;
  const data=canvas.toDataURL('image/png');
  const [mmW,mmH]=sizes[$('#paperSize').value];
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${mmW}mm" height="${mmH}mm" viewBox="0 0 ${canvas.width} ${canvas.height}"><image width="${canvas.width}" height="${canvas.height}" href="${data}"/></svg>`;
  downloadBlob(new Blob([svg],{type:'image/svg+xml'}),'etter-schablone.svg');
});
$('#exportPdfBtn').addEventListener('click',()=>{
  if(!state.generated)return;
  const jpeg=canvas.toDataURL('image/jpeg',.92);
  const [mmW,mmH]=sizes[$('#paperSize').value];
  const pdf=buildPdfWithJpeg(jpeg,mmW,mmH,canvas.width,canvas.height);
  downloadBlob(pdf,'etter-schablone.pdf');
});

function downloadData(url,name){const a=document.createElement('a');a.href=url;a.download=name;a.click();}
function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}

function buildPdfWithJpeg(dataUrl,mmW,mmH,imgW,imgH){
  const b64=dataUrl.split(',')[1], bin=atob(b64), bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  const ptW=mmW*72/25.4, ptH=mmH*72/25.4;
  const enc=s=>new TextEncoder().encode(s);
  const parts=[], offsets=[0]; let len=0;
  const push=u=>{parts.push(u);len+=u.length;};
  const str=s=>push(enc(s));
  str('%PDF-1.4\n');
  offsets[1]=len; str('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n');
  offsets[2]=len; str('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n');
  offsets[3]=len; str(`3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptW.toFixed(2)} ${ptH.toFixed(2)}] /Resources<< /XObject<< /Im0 4 0 R >> >> /Contents 5 0 R >>endobj\n`);
  offsets[4]=len; str(`4 0 obj<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>stream\n`); push(bytes); str('\nendstream endobj\n');
  const content=`q ${ptW.toFixed(2)} 0 0 ${ptH.toFixed(2)} 0 0 cm /Im0 Do Q`;
  offsets[5]=len; str(`5 0 obj<< /Length ${content.length} >>stream\n${content}\nendstream endobj\n`);
  const xref=len; str('xref\n0 6\n0000000000 65535 f \n');
  for(let i=1;i<=5;i++)str(String(offsets[i]).padStart(10,'0')+' 00000 n \n');
  str(`trailer<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts,{type:'application/pdf'});
}
