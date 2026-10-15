const BASE="http://127.0.0.1:8799";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const convs=()=>fetch(BASE+"/api/conversations").then(r=>r.json());
const before=(await convs()).map(c=>c.id);
await fetch(BASE+"/api/send",{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({message:"查看 demo_plot.png 的尺寸（宽高像素），只回复尺寸。",cwd:"C:/Users/Admin01/dsh-codex-bridge",timeout_ms:300000})});
let v;
for(let i=0;i<25;i++){ await sleep(2000); const l=await convs(); v=l.find(c=>!before.includes(c.id)); if(v&&v.status!=="running")break; }
console.log("conversation:",v.id,"status:",v.status);
const imgs=[]; for(const b of v.blocks) if(b.images&&b.images.length) imgs.push(...b.images);
console.log("images in conversation:",JSON.stringify(imgs));
if(imgs.length){ const r=await fetch(BASE+"/api/file?path="+encodeURIComponent(imgs[0]));
  console.log("served:",r.status,r.headers.get("content-type"),(await r.arrayBuffer()).byteLength,"bytes"); }
console.log("blocks:"); for(const b of v.blocks) console.log("  ["+b.kind+"] "+String(b.text??b.name??"").slice(0,42).replace(/\n/g," ")+(b.images&&b.images.length?"  <<"+b.images.length+" img>>":""));
