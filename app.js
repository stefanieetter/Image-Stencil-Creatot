const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const canvas = $('#mainCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const sizes = {
  A4:[210,297], A3:[297,420], A2:[420,594], A1:[594,841], A0:[841,1189]
};

const state = {
  mode:'stencil',
  source:null,
  fileName:'',
  zoom:1,
  eraser:false,
  drawing:false,
  inverted:false,
  generated:false,
  history:[],
  redo:[],
  variants:[],
  exportMask:null,
  exportW:0,
  exportH:0,
  report:null
};

function setStatus(t){ $('#status').textContent = t; }
function showCanvas(){ $('#emptyState').classList.add('hidden'); }
function mmSize(){ return sizes[$('#paperSize').value]; }
function currentLongEdge(){
  const q = $('#qualityMode').value;
  if(q==='standard') return 1400;
  if(q==='max') return 2200;
  return 1800;
}

function fitImage(img,w,h){
  const r = Math.min(w/img.width,h/img.height);
  return {w:img.width*r,h:img.height*r,x:(w-img.width*r)/2,y:(h-img.height*r)/2};
}

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
  state.mode = btn.dataset.mode;
  $$('.variant-only').forEach(el=>el.classList.toggle('hidden', state.mode!=='variants'));
  $('#generateBtn').textContent = state.mode==='variants' ? '5 Varianten erzeugen' : 'Schablone erzeugen';
  $('#variantsWrap').classList.toggle('hidden', state.mode!=='variants');
}));

['detail','contrast','cleanup','variation'].forEach(id=>{
  const input = $('#'+id), out = $('#'+id+'Out');
  if(input && out) input.addEventListener('input',()=> out.value = input.value);
});

$('#fileInput').addEventListener('change', e=>{
  const f = e.target.files[0];
  if(!f) return;
  state.fileName = f.name;
  $('#fileName').textContent = f.name;
  const img = new Image();
  img.onload = ()=>{
    state.source = img;
    drawSourcePreview();
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(f);
});

function drawSourcePreview(){
  if(!state.source) return;
  const [mmW,mmH] = mmSize();
  const previewW = 900;
  const previewH = Math.round(previewW*mmH/mmW);
  canvas.width = previewW; canvas.height = previewH;
  ctx.fillStyle = 'white'; ctx.fillRect(0,0,canvas.width,canvas.height);
  const f = fitImage(state.source, canvas.width, canvas.height);
  ctx.drawImage(state.source, f.x, f.y, f.w, f.h);
  showCanvas();
  state.generated = false;
  state.exportMask = null;
  state.report = null;
  state.history = []; state.redo = [];
  setStatus('Bild geladen');
}

function luminance(r,g,b){ return 0.2126*r + 0.7152*g + 0.0722*b; }

function buildStencil(options={}){
  const {variantIndex=0, remixed=false} = options;
  if(!state.source) return null;
  const [mmW,mmH] = mmSize();
  const longEdge = currentLongEdge();
  let w,h;
  if(mmH >= mmW){
    h = longEdge;
    w = Math.round(longEdge * mmW / mmH);
  } else {
    w = longEdge;
    h = Math.round(longEdge * mmH / mmW);
  }

  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const o = off.getContext('2d', { willReadFrequently:true });
  o.fillStyle = '#fff'; o.fillRect(0,0,w,h);

  const f = fitImage(state.source, w, h);
  o.save();
  if(remixed){
    const s = (+$('#variation').value || 35) / 100;
    const r1 = seeded(variantIndex*17+2), r2 = seeded(variantIndex*23+7), r3 = seeded(variantIndex*31+11), r4 = seeded(variantIndex*41+19);
    const angle = ((r1*2-1) * 0.06 * (0.3+s));
    const scale = 1 + ((r2*2-1) * 0.12 * (0.35+s));
    const shiftX = (r3*2-1) * w * 0.07 * (0.3+s);
    const shiftY = (r4*2-1) * h * 0.07 * (0.3+s);
    const mirror = seeded(variantIndex*53+5) > 0.72;
    o.translate(w/2 + shiftX, h/2 + shiftY);
    o.rotate(angle);
    o.scale(mirror ? -scale : scale, scale);
    o.drawImage(state.source, -w/2 + f.x, -h/2 + f.y, f.w, f.h);
  } else {
    o.drawImage(state.source, f.x, f.y, f.w, f.h);
  }
  o.restore();

  let img = o.getImageData(0,0,w,h);
  let gray = toGray(img.data, w, h);

  const detail = +$('#detail').value;
  const contrast = +$('#contrast').value;
  const cleanup = +$('#cleanup').value;

  const sourceLooksClean = detectCleanArtwork(gray, w, h);
  const blurRadius = sourceLooksClean ? Math.max(0, Math.round((25-cleanup)/25)) : Math.max(1, Math.round((55-detail)/22));
  if(blurRadius>0) gray = boxBlur(gray, w, h, blurRadius);

  let threshold = otsuThreshold(gray);
  threshold += Math.round((50-contrast) * 0.75);
  threshold = Math.max(20, Math.min(235, threshold));

  const darkForeground = estimateDarkForeground(gray, w, h);
  let mask = new Uint8Array(w*h);
  for(let i=0;i<gray.length;i++){
    const isDark = gray[i] < threshold;
    mask[i] = darkForeground ? (isDark ? 1 : 0) : (isDark ? 0 : 1);
  }

  const blackMinArea = Math.max(16, Math.round((100-detail) * 1.2 + cleanup * 2));
  const whiteMinArea = Math.max(10, Math.round(cleanup * 1.8 + (100-detail) * 0.8));

  // Clean edges and remove speckles.
  const cycles = cleanup > 70 ? 2 : 1;
  for(let i=0;i<cycles;i++){
    mask = majorityPass(mask, w, h);
  }

  mask = removeSmallComponents(mask, w, h, 1, blackMinArea, false);
  mask = removeSmallComponents(mask, w, h, 0, whiteMinArea, true);

  if(!$('#keepText').checked){
    mask = softenTinyText(mask, w, h);
  }

  if($('#keepFrame').checked){
    mask = preserveBorderFrame(mask, w, h);
  }

  return {
    mask, w, h,
    report: {
      threshold,
      blackMinArea,
      whiteMinArea,
      sourceLooksClean,
      components: countComponents(mask, w, h, 1)
    }
  };
}

function detectCleanArtwork(gray,w,h){
  let transitions = 0, sample = 0;
  const step = Math.max(2, Math.floor(Math.min(w,h)/80));
  for(let y=step; y<h-step; y+=step){
    for(let x=step; x<w-step; x+=step){
      const i = y*w+x;
      sample++;
      const a = gray[i], b = gray[i+1], c = gray[i+w];
      if(Math.abs(a-b) > 28) transitions++;
      if(Math.abs(a-c) > 28) transitions++;
    }
  }
  const rate = transitions / Math.max(1,sample*2);
  return rate > 0.32;
}

function estimateDarkForeground(gray,w,h){
  let sum=0,c=0;
  const margin = Math.max(3, Math.round(Math.min(w,h)*0.05));
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      if(x<margin||y<margin||x>=w-margin||y>=h-margin){ sum += gray[y*w+x]; c++; }
    }
  }
  const borderMean = sum / Math.max(1,c);
  return borderMean > 120;
}

function toGray(data,w,h){
  const gray = new Uint8Array(w*h);
  for(let i=0,j=0;i<data.length;i+=4,j++) gray[j] = Math.round(luminance(data[i],data[i+1],data[i+2]));
  return gray;
}

function boxBlur(src,w,h,r){
  const tmp = new Uint16Array(w*h);
  const out = new Uint8Array(w*h);
  for(let y=0;y<h;y++){
    let sum=0;
    for(let x=-r;x<=r;x++) sum += src[y*w + Math.min(w-1, Math.max(0,x))];
    for(let x=0;x<w;x++){
      tmp[y*w+x] = sum;
      const addX = Math.min(w-1, x+r+1);
      const subX = Math.max(0, x-r);
      sum += src[y*w+addX] - src[y*w+subX];
    }
  }
  for(let x=0;x<w;x++){
    let sum=0;
    for(let y=-r;y<=r;y++) sum += tmp[Math.min(h-1, Math.max(0,y))*w + x];
    for(let y=0;y<h;y++){
      const area = (2*r+1)*(2*r+1);
      out[y*w+x] = Math.round(sum / area);
      const addY = Math.min(h-1, y+r+1);
      const subY = Math.max(0, y-r);
      sum += tmp[addY*w+x] - tmp[subY*w+x];
    }
  }
  return out;
}

function otsuThreshold(gray){
  const hist = new Uint32Array(256);
  for(let i=0;i<gray.length;i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for(let i=0;i<256;i++) sum += i*hist[i];
  let sumB=0, wB=0, wF=0, bestVar=0, threshold=128;
  for(let t=0;t<256;t++){
    wB += hist[t]; if(!wB) continue;
    wF = total - wB; if(!wF) break;
    sumB += t*hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    if(variance > bestVar){ bestVar = variance; threshold = t; }
  }
  return threshold;
}

function majorityPass(mask,w,h){
  const out = mask.slice();
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      let s=0;
      for(let yy=-1;yy<=1;yy++) for(let xx=-1;xx<=1;xx++) s += mask[(y+yy)*w + x+xx];
      if(s >= 6) out[y*w+x] = 1;
      else if(s <= 3) out[y*w+x] = 0;
    }
  }
  return out;
}

function removeSmallComponents(mask,w,h,target,minArea,fillInstead){
  const seen = new Uint8Array(w*h);
  const out = mask.slice();
  const q = new Int32Array(w*h);
  const dirs = [1,-1,w,-w];
  for(let i=0;i<mask.length;i++){
    if(seen[i] || mask[i] !== target) continue;
    let head=0, tail=0;
    q[tail++] = i;
    seen[i] = 1;
    const pts = [];
    let touchesEdge = false;
    while(head<tail){
      const p = q[head++];
      pts.push(p);
      const y = (p / w) | 0;
      const x = p - y*w;
      if(x===0||y===0||x===w-1||y===h-1) touchesEdge = true;
      if(x+1<w){ const n=p+1; if(!seen[n]&&mask[n]===target){ seen[n]=1; q[tail++]=n; } }
      if(x>0){ const n=p-1; if(!seen[n]&&mask[n]===target){ seen[n]=1; q[tail++]=n; } }
      if(y+1<h){ const n=p+w; if(!seen[n]&&mask[n]===target){ seen[n]=1; q[tail++]=n; } }
      if(y>0){ const n=p-w; if(!seen[n]&&mask[n]===target){ seen[n]=1; q[tail++]=n; } }
    }
    const shouldFill = pts.length < minArea && (target===1 || !touchesEdge || fillInstead);
    if(shouldFill){
      const value = target===1 ? 0 : 1;
      for(let k=0;k<pts.length;k++) out[pts[k]] = value;
    }
  }
  return out;
}

function softenTinyText(mask,w,h){
  // Remove very small, thin components that often come from tiny typography.
  const seen = new Uint8Array(w*h);
  const out = mask.slice();
  const q = new Int32Array(w*h);
  for(let i=0;i<mask.length;i++){
    if(seen[i] || mask[i]!==1) continue;
    let head=0, tail=0, minX=w, minY=h, maxX=0, maxY=0;
    q[tail++]=i; seen[i]=1;
    const pts=[];
    while(head<tail){
      const p=q[head++]; pts.push(p);
      const y=(p/w)|0, x=p-y*w;
      if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y;
      if(x+1<w){const n=p+1; if(!seen[n]&&mask[n]===1){seen[n]=1;q[tail++]=n;}}
      if(x>0){const n=p-1; if(!seen[n]&&mask[n]===1){seen[n]=1;q[tail++]=n;}}
      if(y+1<h){const n=p+w; if(!seen[n]&&mask[n]===1){seen[n]=1;q[tail++]=n;}}
      if(y>0){const n=p-w; if(!seen[n]&&mask[n]===1){seen[n]=1;q[tail++]=n;}}
    }
    const bw=maxX-minX+1, bh=maxY-minY+1;
    if(pts.length < 900 && bh < Math.max(12, h*0.035) && bw > bh*1.1){
      for(let k=0;k<pts.length;k++) out[pts[k]] = 0;
    }
  }
  return out;
}

function preserveBorderFrame(mask,w,h){
  const out = mask.slice();
  const band = Math.max(3, Math.round(Math.min(w,h)*0.01));
  let blackTop=0, blackBottom=0, blackLeft=0, blackRight=0;
  for(let x=0;x<w;x++) for(let y=0;y<band;y++) blackTop += mask[y*w+x];
  for(let x=0;x<w;x++) for(let y=h-band;y<h;y++) blackBottom += mask[y*w+x];
  for(let y=0;y<h;y++) for(let x=0;x<band;x++) blackLeft += mask[y*w+x];
  for(let y=0;y<h;y++) for(let x=w-band;x<w;x++) blackRight += mask[y*w+x];
  const bandAreaHorizontal = w*band;
  const bandAreaVertical = h*band;
  const keepFrame = blackTop/bandAreaHorizontal > 0.2 && blackBottom/bandAreaHorizontal > 0.2 && blackLeft/bandAreaVertical > 0.2 && blackRight/bandAreaVertical > 0.2;
  if(keepFrame){
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      if(x<band||y<band||x>=w-band||y>=h-band) out[y*w+x] = 1;
    }
  }
  return out;
}

function countComponents(mask,w,h,target){
  const seen = new Uint8Array(w*h);
  let count = 0;
  const q = new Int32Array(w*h);
  for(let i=0;i<mask.length;i++){
    if(seen[i] || mask[i]!==target) continue;
    count++;
    let head=0, tail=0; q[tail++]=i; seen[i]=1;
    while(head<tail){
      const p=q[head++];
      const y=(p/w)|0, x=p-y*w;
      if(x+1<w){const n=p+1; if(!seen[n]&&mask[n]===target){seen[n]=1;q[tail++]=n;}}
      if(x>0){const n=p-1; if(!seen[n]&&mask[n]===target){seen[n]=1;q[tail++]=n;}}
      if(y+1<h){const n=p+w; if(!seen[n]&&mask[n]===target){seen[n]=1;q[tail++]=n;}}
      if(y>0){const n=p-w; if(!seen[n]&&mask[n]===target){seen[n]=1;q[tail++]=n;}}
    }
  }
  return count;
}

function optimizeMask(mask,w,h){
  const [mmW] = mmSize();
  const pxPerMm = w / mmW;
  const bridgePx = Math.max(3, Math.round((+$('#bridgeMm').value) * pxPerMm));
  let out = removeSmallComponents(mask, w, h, 1, bridgePx*bridgePx*0.35, false);
  const result = bridgeBlackIslands(out, w, h, bridgePx);
  out = result.mask;
  out = majorityPass(out, w, h);
  out = removeSmallComponents(out, w, h, 0, Math.max(10, Math.round(bridgePx*bridgePx*0.18)), true);
  return { mask: out, report: result.report, bridgePx };
}

function bridgeBlackIslands(mask,w,h,bridgePx){
  const seen = new Uint8Array(w*h);
  const q = new Int32Array(w*h);
  const comps = [];
  for(let i=0;i<mask.length;i++){
    if(seen[i] || mask[i]!==1) continue;
    let head=0, tail=0;
    q[tail++]=i; seen[i]=1;
    let pts=[], sumX=0, sumY=0, touch=false;
    while(head<tail){
      const p=q[head++]; pts.push(p);
      const y=(p/w)|0, x=p-y*w;
      sumX += x; sumY += y;
      if(x===0||y===0||x===w-1||y===h-1) touch=true;
      if(x+1<w){const n=p+1; if(!seen[n]&&mask[n]===1){seen[n]=1;q[tail++]=n;}}
      if(x>0){const n=p-1; if(!seen[n]&&mask[n]===1){seen[n]=1;q[tail++]=n;}}
      if(y+1<h){const n=p+w; if(!seen[n]&&mask[n]===1){seen[n]=1;q[tail++]=n;}}
      if(y>0){const n=p-w; if(!seen[n]&&mask[n]===1){seen[n]=1;q[tail++]=n;}}
    }
    comps.push({pts, touch, cx:sumX/pts.length, cy:sumY/pts.length, size:pts.length});
  }
  const out = mask.slice();
  let bridged=0, removed=0;
  for(const c of comps){
    if(c.touch) continue;
    if(c.size < bridgePx*bridgePx*0.5){
      for(const p of c.pts) out[p]=0;
      removed++;
      continue;
    }
    const dxLeft = c.cx;
    const dxRight = w-1-c.cx;
    const dyTop = c.cy;
    const dyBottom = h-1-c.cy;
    const options = [
      {d:dxLeft, x:0, y:c.cy},
      {d:dxRight, x:w-1, y:c.cy},
      {d:dyTop, x:c.cx, y:0},
      {d:dyBottom, x:c.cx, y:h-1}
    ].sort((a,b)=>a.d-b.d);
    drawThickLine(out, w, h, Math.round(c.cx), Math.round(c.cy), Math.round(options[0].x), Math.round(options[0].y), bridgePx);
    bridged++;
  }
  return { mask: out, report: { components: comps.length, bridged, removed } };
}

function drawThickLine(mask,w,h,x0,y0,x1,y1,diameter){
  const steps = Math.max(Math.abs(x1-x0), Math.abs(y1-y0), 1);
  const rad = Math.max(1, Math.floor(diameter/2));
  for(let s=0;s<=steps;s++){
    const t = s/steps;
    const x = Math.round(x0 + (x1-x0)*t);
    const y = Math.round(y0 + (y1-y0)*t);
    for(let yy=y-rad; yy<=y+rad; yy++){
      if(yy<0||yy>=h) continue;
      for(let xx=x-rad; xx<=x+rad; xx++){
        if(xx<0||xx>=w) continue;
        if((xx-x)*(xx-x)+(yy-y)*(yy-y) <= rad*rad) mask[yy*w+xx] = 1;
      }
    }
  }
}

function commitResult(mask,w,h,report){
  state.exportMask = mask;
  state.exportW = w;
  state.exportH = h;
  state.report = report || null;
  renderMaskToMain();
  state.generated = true;
  state.history = []; state.redo = [];
  snapshot();
  showCanvas();
}

function renderMask(mask,targetCanvas,w,h){
  targetCanvas.width = w;
  targetCanvas.height = h;
  const c = targetCanvas.getContext('2d');
  const img = c.createImageData(w,h);
  for(let i=0;i<mask.length;i++){
    let black = mask[i]===1;
    if(state.inverted) black = !black;
    const v = black ? 0 : 255;
    const j=i*4;
    img.data[j]=img.data[j+1]=img.data[j+2]=v;
    img.data[j+3]=255;
  }
  c.putImageData(img,0,0);
}

function renderMaskToMain(){
  if(!state.exportMask) return;
  renderMask(state.exportMask, canvas, state.exportW, state.exportH);
}

$('#generateBtn').addEventListener('click', async ()=>{
  if(!state.source){ alert('Bitte zuerst ein Bild hochladen.'); return; }
  setStatus('Wird erzeugt …');
  await pause();
  if(state.mode === 'stencil'){
    const res = buildStencil();
    commitResult(res.mask, res.w, res.h, {
      mode: 'Qualitätsmodus',
      components: res.report.components,
      bridged: 0,
      removed: 0,
      looksClean: res.report.sourceLooksClean,
      threshold: res.report.threshold
    });
    updateValidation();
    $('#variantsWrap').classList.add('hidden');
  } else {
    const wrap = $('#variants');
    wrap.innerHTML = '';
    state.variants = [];
    for(let i=0;i<5;i++){
      const res = buildStencil({variantIndex:i+1, remixed:true});
      state.variants.push(res);
      const card = document.createElement('div');
      card.className = 'variant-card';
      const c = document.createElement('canvas');
      renderMask(res.mask, c, res.w, res.h);
      card.appendChild(c);
      card.addEventListener('click',()=>{
        $$('.variant-card').forEach(x=>x.classList.remove('selected'));
        card.classList.add('selected');
        commitResult(res.mask, res.w, res.h, {
          mode: 'Variante',
          components: res.report.components,
          bridged: 0,
          removed: 0,
          looksClean: res.report.sourceLooksClean,
          threshold: res.report.threshold
        });
        updateValidation();
      });
      wrap.appendChild(card);
    }
    $('#variantsWrap').classList.remove('hidden');
    wrap.firstChild?.click();
  }
  setStatus('Fertig');
});

$('#optimizeBtn').addEventListener('click', async ()=>{
  if(!state.exportMask){ alert('Bitte zuerst eine Schablone erzeugen.'); return; }
  setStatus('Wird geprüft & optimiert …');
  await pause();
  snapshot();
  const result = optimizeMask(state.exportMask, state.exportW, state.exportH);
  state.exportMask = result.mask;
  state.report = {
    mode: 'Technisch optimiert',
    components: result.report.components,
    bridged: result.report.bridged,
    removed: result.report.removed,
    bridgePx: result.bridgePx
  };
  renderMaskToMain();
  updateValidation();
  setStatus('Optimiert');
});

function updateValidation(){
  if(!state.report){
    $('#validationTitle').textContent='Noch nicht geprüft';
    $('#validationText').textContent='Nach der Generierung wird die Schablone analysiert.';
    return;
  }
  $('#validationTitle').textContent = state.report.mode === 'Technisch optimiert'
    ? 'Technische Prüfung abgeschlossen'
    : 'Saubere Vorschau erzeugt';
  if(state.report.mode === 'Technisch optimiert'){
    $('#validationText').textContent = `Komponenten: ${state.report.components} · Brücken gesetzt: ${state.report.bridged} · kleine Inseln entfernt: ${state.report.removed}`;
  } else {
    $('#validationText').textContent = `Komponenten: ${state.report.components} · Rauschreduktion aktiv · Brücken noch nicht aggressiv gesetzt`;
  }
}

$('#invertBtn').addEventListener('click',()=>{
  if(!state.exportMask) return;
  state.inverted = !state.inverted;
  renderMaskToMain();
  snapshot();
});
$('#zoomInBtn').addEventListener('click',()=>setZoom(state.zoom+0.1));
$('#zoomOutBtn').addEventListener('click',()=>setZoom(state.zoom-0.1));
function setZoom(z){ state.zoom = Math.min(2.5, Math.max(0.35, z)); canvas.style.transform = `scale(${state.zoom})`; $('#zoomLabel').textContent = Math.round(state.zoom*100)+'%'; }

$('#eraserBtn').addEventListener('click',()=>{ state.eraser = !state.eraser; $('#eraserBtn').classList.toggle('primary', state.eraser); });
canvas.addEventListener('pointerdown', e=>{ if(!state.eraser || !state.exportMask) return; snapshot(); state.drawing = true; eraseAt(e); });
canvas.addEventListener('pointermove', e=>{ if(state.drawing) eraseAt(e); });
window.addEventListener('pointerup', ()=> state.drawing = false);
function eraseAt(e){
  const rect = canvas.getBoundingClientRect();
  const x = Math.round((e.clientX-rect.left) * canvas.width / rect.width);
  const y = Math.round((e.clientY-rect.top) * canvas.height / rect.height);
  const r = Math.max(8, Math.round(canvas.width*0.012));
  for(let yy=y-r; yy<=y+r; yy++){
    if(yy<0||yy>=canvas.height) continue;
    for(let xx=x-r; xx<=x+r; xx++){
      if(xx<0||xx>=canvas.width) continue;
      if((xx-x)*(xx-x)+(yy-y)*(yy-y) <= r*r){
        state.exportMask[yy*canvas.width + xx] = state.inverted ? 1 : 0;
      }
    }
  }
  renderMaskToMain();
}

$('#undoBtn').addEventListener('click',()=>{
  if(state.history.length < 2) return;
  const current = state.history.pop();
  state.redo.push(current);
  restore(state.history[state.history.length-1]);
});
$('#redoBtn').addEventListener('click',()=>{
  if(!state.redo.length) return;
  const img = state.redo.pop();
  state.history.push(img);
  restore(img);
});

$('#exportJpgBtn').addEventListener('click',()=>{
  if(!state.exportMask) return;
  const tmp = document.createElement('canvas');
  renderMask(state.exportMask, tmp, state.exportW, state.exportH);
  downloadData(tmp.toDataURL('image/jpeg', 0.96), 'etter-schablone-v2.jpg');
});

$('#exportSvgBtn').addEventListener('click',()=>{
  if(!state.exportMask) return;
  const svg = maskToSVG(state.exportMask, state.exportW, state.exportH, state.inverted);
  downloadBlob(new Blob([svg], {type:'image/svg+xml'}), 'etter-schablone-v2.svg');
});

$('#exportPdfBtn').addEventListener('click',()=>{
  if(!state.exportMask) return;
  const tmp = document.createElement('canvas');
  renderMask(state.exportMask, tmp, state.exportW, state.exportH);
  const jpeg = tmp.toDataURL('image/jpeg', 0.94);
  const [mmW,mmH] = mmSize();
  const pdf = buildPdfWithJpeg(jpeg, mmW, mmH, state.exportW, state.exportH);
  downloadBlob(pdf, 'etter-schablone-v2.pdf');
});

function maskToSVG(mask,w,h,inverted){
  const [mmW,mmH] = mmSize();
  let path = '';
  for(let y=0;y<h;y++){
    let x=0;
    while(x<w){
      let black = mask[y*w+x]===1;
      if(inverted) black = !black;
      if(!black){ x++; continue; }
      let x2 = x+1;
      while(x2<w){
        let b = mask[y*w+x2]===1;
        if(inverted) b = !b;
        if(!b) break;
        x2++;
      }
      const run = x2-x;
      path += `M${x} ${y}h${run}v1h-${run}z`;
      x = x2;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${mmW}mm" height="${mmH}mm" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">\n  <rect width="100%" height="100%" fill="white"/>\n  <path d="${path}" fill="black"/>\n</svg>`;
}

function buildPdfWithJpeg(dataUrl,mmW,mmH,imgW,imgH){
  const b64=dataUrl.split(',')[1], bin=atob(b64), bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  const ptW=mmW*72/25.4, ptH=mmH*72/25.4;
  const enc=s=>new TextEncoder().encode(s);
  const parts=[], offsets=[0]; let len=0;
  const push=u=>{parts.push(u); len+=u.length;};
  const str=s=>push(enc(s));
  str('%PDF-1.4\n');
  offsets[1]=len; str('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n');
  offsets[2]=len; str('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n');
  offsets[3]=len; str(`3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptW.toFixed(2)} ${ptH.toFixed(2)}] /Resources<< /XObject<< /Im0 4 0 R >> >> /Contents 5 0 R >>endobj\n`);
  offsets[4]=len; str(`4 0 obj<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>stream\n`); push(bytes); str('\nendstream endobj\n');
  const content=`q ${ptW.toFixed(2)} 0 0 ${ptH.toFixed(2)} 0 0 cm /Im0 Do Q`;
  offsets[5]=len; str(`5 0 obj<< /Length ${content.length} >>stream\n${content}\nendstream endobj\n`);
  const xref=len; str('xref\n0 6\n0000000000 65535 f \n');
  for(let i=1;i<=5;i++) str(String(offsets[i]).padStart(10,'0')+' 00000 n \n');
  str(`trailer<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts,{type:'application/pdf'});
}

function downloadData(url,name){ const a=document.createElement('a'); a.href=url; a.download=name; a.click(); }
function downloadBlob(blob,name){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 1200); }
function pause(){ return new Promise(r=>setTimeout(r,30)); }
function seeded(n){ const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); }
