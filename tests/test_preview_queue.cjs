const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const js=fs.readFileSync(require('node:path').join(__dirname,'../frontend/app.js'),'utf8');
let cards=[],comparisons=[],messages=[],starts=[],nextTimer=0,timers=new Map();
function make(id,top=10,split=false,managed=true){
 const attrs={};const listeners={};const owner={hidden:false,style:{order:id.charCodeAt(0)}};
 const status={hidden:false,querySelector:s=>s==='[data-retry-preview]'?status.retry:status.message,retry:{hidden:true},message:{textContent:''}};
 const wrapper={getBoundingClientRect:()=>({top,bottom:top+140,width:300,height:140,left:0,right:300}),querySelector:()=>status};
 const f={id,isConnected:true,dataset:{previewSrc:'https://api.example.com/projects/'+id+'/index.html',managed:String(managed)},parentElement:wrapper,contentWindow:{postMessage:m=>messages.push({id,...m})},closest:s=>s==='#comparison-grid'?(split?{}:null):(split?null:owner),getAttribute:k=>attrs[k],removeAttribute:k=>delete attrs[k],addEventListener:(name,fn)=>listeners[name]=fn,removeEventListener:name=>delete listeners[name],set src(v){attrs.src=v;starts.push(id)},load(){listeners.load?.()},owner,status};return f;
}
let handler;
const ctx={elements:{projectList:{querySelectorAll:()=>cards.filter(f=>!f.getAttribute('src'))},comparisonGrid:{querySelectorAll:()=>comparisons.filter(f=>!f.getAttribute('src'))},compareDialog:{open:false},projectDialog:{open:false},groupDialog:{open:false},loginDialog:{open:false}},document:{hidden:false,querySelectorAll:()=>[...cards,...comparisons]},navigator:{onLine:true},location:{protocol:'https:'},URL,innerWidth:1200,innerHeight:800,thumbnailsEnabled:true,restoringView:false,$:()=>({open:false}),IntersectionObserver:class{observe(){}unobserve(){}},window:{addEventListener:(type,fn)=>{handler=fn}},requestAnimationFrame:()=>1,updateSyncStatus(){},setTimeout:(fn,ms)=>{timers.set(++nextTimer,{fn,ms});return nextTimer},clearTimeout:id=>timers.delete(id)};
vm.createContext(ctx);
vm.runInContext(js.slice(js.indexOf('  const PREVIEW_TIMEOUT ='),js.indexOf('  const splitFrames =')),ctx);
async function settle(){await Promise.resolve();await Promise.resolve()}
async function gap(){await settle();for(const [id,t]of timers){if(t.ms===800){timers.delete(id);t.fn();break}}await settle()}
const ack=f=>handler({source:f.contentWindow,data:{channel:'prompt-gallery-render-v1',type:'loaded'}});
(async()=>{
 const near=make('a',850),visible=make('b',20),far=make('c',2000);cards=[near,visible,far];
 assert.equal(ctx.nextCardPreview(),visible,'visible before prefetch');
 let running=ctx.queueCardPreviews();assert.deepEqual(starts,['b']);
 visible.load();await settle();assert.deepEqual(starts,['b'],'bare iframe load does not complete managed page');
 ack(visible);await gap();assert.deepEqual(starts,['b','a']);ack(near);await gap();await running;assert(!starts.includes('c'));
 ctx.configureRendering(near);assert.equal(messages.at(-1).paused,true,'offscreen rendering paused');
 ctx.configureRendering(visible);assert.equal(messages.findLast(m=>m.id==='b').paused,false);
 ctx.document.hidden=true;ctx.configureRendering(visible);assert.equal(messages.at(-1).paused,true);assert.equal(ctx.nextCardPreview(),null);ctx.document.hidden=false;
 const slow=make('d'),later=make('e');cards=[slow,later];running=ctx.queueCardPreviews();
 const timeout=[...timers.entries()].find(([id,t])=>t.ms===45000);timers.delete(timeout[0]);timeout[1].fn();await gap();assert.equal(slow.dataset.failed,'true');assert.equal(slow.getAttribute('src'),undefined);assert.equal(starts.at(-1),'e');ack(later);await gap();await running;
 slow.dataset.failed='false';running=ctx.queueCardPreviews();assert.equal(starts.at(-1),'d');ack(slow);await gap();await running;
 ctx.elements.compareDialog.open=true;ctx.thumbnailsEnabled=false;comparisons=[make('f',0,true),make('g',0,true)];
 running=ctx.queueCardPreviews();assert.equal(starts.at(-1),'f');ack(comparisons[0]);await gap();assert.equal(starts.at(-1),'g');ack(comparisons[1]);await gap();await running;
 ctx.elements.compareDialog.open=false;cards=[make('h')];assert.equal(ctx.nextCardPreview(),null,'thumbnail toggle preserved');
 ctx.thumbnailsEnabled=true;ctx.navigator.onLine=false;assert.equal(ctx.nextCardPreview(),null);ctx.navigator.onLine=true;
 cards[0].dataset.previewSrc='http://external.example.com/';running=ctx.queueCardPreviews();await running;assert.equal(cards[0].dataset.failed,'true');assert(!starts.includes('h'),'HTTPS mixed content never navigated');
 console.log('PASS: serial viewport priority, managed load acknowledgement, timeout/retry, visibility pause, serialized split, toggle/offline and HTTPS handling');
})().catch(e=>{console.error(e);process.exitCode=1});
