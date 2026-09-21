import puppeteer from 'puppeteer';
const b=await puppeteer.launch({headless:true,args:['--no-sandbox']});
const p=await b.newPage();
await p.setViewport({width:1440,height:900});
await p.goto('http://localhost:4199',{waitUntil:'networkidle2'});
await p.evaluate(()=>{document.querySelectorAll('img[loading="lazy"]').forEach(i=>i.loading='eager')});
await p.evaluate(()=>document.querySelectorAll('.reveal').forEach(e=>e.classList.add('visible')));
await new Promise(r=>setTimeout(r,2600));
await p.addStyleTag({content:'body::before{animation:none!important;transform:translate3d(1.5%,1.5%,0) scale(1.07)!important}'});
await new Promise(r=>setTimeout(r,300));
const sR=c=>{c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4)};
const lum=(r,g,bl)=>0.2126*sR(r)+0.7152*sR(g)+0.0722*sR(bl);
const rat=(a,b)=>(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
const targets=await p.evaluate(()=>{const out=[];
  document.querySelectorAll('.section, .reviews-section').forEach(sec=>{
    sec.querySelectorAll('h2,p.lede,.eyebrow,.accent').forEach(el=>{
      if(el.closest('.card,.hero-rates,.form-card,.rate-table')) return;
      const b=el.getBoundingClientRect(); if(b.width<8||b.height<8) return;
      el.dataset.ck=out.length;
      out.push({id:out.length, sec:sec.id||sec.className.split(' ')[1], txt:el.textContent.trim().slice(0,20)});});});
  return out;});
const rows=[];
for (const t of targets) {
  const abs=await p.evaluate(i=>{const e=document.querySelector(`[data-ck="${i}"]`);
    return e.getBoundingClientRect().top+window.scrollY;},t.id);
  await p.evaluate(y=>window.scrollTo(0,Math.max(0,y-420)),abs);
  await new Promise(r=>setTimeout(r,260));
  const r=await p.evaluate(i=>{const e=document.querySelector(`[data-ck="${i}"]`);const b=e.getBoundingClientRect();
    e.style.visibility='hidden';
    return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),
            gold:getComputedStyle(e).webkitTextFillColor==='rgba(0, 0, 0, 0)'};},t.id);
  const shot=(await p.screenshot({captureBeyondViewport:false})).toString('base64');
  await p.evaluate(i=>document.querySelector(`[data-ck="${i}"]`).style.visibility='',t.id);
  if(r.y<0||r.y+r.h>900) continue;
  const px=await p.evaluate(async(d,R)=>{const img=new Image();img.src='data:image/png;base64,'+d;await img.decode();
    const c=document.createElement('canvas');c.width=R.w;c.height=R.h;
    const x=c.getContext('2d');x.drawImage(img,R.x,R.y,R.w,R.h,0,0,R.w,R.h);
    const q=x.getImageData(0,0,R.w,R.h).data;const L=[];
    for(let i=0;i<q.length;i+=4)L.push([q[i],q[i+1],q[i+2]]);
    L.sort((a,b)=>(0.2126*b[0]+0.7152*b[1]+0.0722*b[2])-(0.2126*a[0]+0.7152*a[1]+0.0722*a[2]));
    return L[Math.floor(L.length*0.02)]},shot,r);
  rows.push({c:rat(r.gold?lum(204,163,119):lum(255,255,255),lum(...px)), px, gold:r.gold, ...t});
}
rows.sort((a,b)=>a.c-b.c);
const brightest = rows.map(r=>r.px).sort((a,b)=>(b[0]+b[1]+b[2])-(a[0]+a[1]+a[2]))[0];
console.log(`sampled ${rows.length} blocks | brightest sampled background rgb(${brightest})\n`);
rows.slice(0,6).forEach(r=>console.log(`  ${r.c.toFixed(1).padStart(5)}:1  ${r.gold?'gold ':'white'} on rgb(${String(r.px).padEnd(12)}) [${r.sec}] "${r.txt}"`));
console.log(`\nworst ${rows[0].c.toFixed(1)}:1 — ${rows[0].c>=7?'PASS (AAA)':'FAIL'}`);
await b.close();
