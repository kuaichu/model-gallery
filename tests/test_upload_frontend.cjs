const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../frontend/app.js'),'utf8');
(async()=>{
  let sent;
  const ctx={Headers,FormData,authToken:'test-session',backendUrl:p=>'https://api.example.test'+p,
    fetch:async(url,options)=>{sent={url,options};return {ok:true,status:200,json:async()=>({id:'saved'})}}};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  async function request('),source.indexOf('  async function restoreSession(')),ctx);
  const multipart=new FormData();multipart.append('metadata','{"title":"test"}');multipart.append('file',new Blob(['<html></html>'],{type:'text/html'}),'demo.html');
  await ctx.request('/api/projects',{method:'POST',body:multipart});
  assert.equal(sent.options.body,multipart);
  assert.equal(sent.options.headers.has('Content-Type'),false,'browser must choose boundary');
  assert.equal(sent.options.headers.get('Authorization'),'Bearer test-session');
  await ctx.request('/api/projects/p',{method:'PATCH',body:JSON.stringify({notes:'edit'})});
  assert.equal(sent.options.headers.get('Content-Type'),'application/json');
  class FormValues {
    constructor(form){this.values=new Map(form?.values||[])}
    append(k,v){this.values.set(k,v)}
    [Symbol.iterator](){return this.values[Symbol.iterator]()}
  }
  const button={disabled:false},status={textContent:''},form={values:[['id','p'],['title','test'],['htmlFile',{}],['rating','0'],['durationMinutes',''],['durationRemainder','']],elements:{htmlFile:{files:[]}},close(){}};
  let calls=[];
  const ui={FormData:FormValues,requireAdmin:()=>true,elements:{projectForm:form,projectDialog:{close(){}}},$:s=>s==='#project-save-status'?status:button,request:async(url,options)=>calls.push({url,options}),loadLibrary:async()=>{},showToast(){}};
  vm.createContext(ui);vm.runInContext(source.slice(source.indexOf('  async function saveProject('),source.indexOf('  async function deleteProject(')),ui);
  await ui.saveProject({preventDefault(){}});
  assert.equal(calls[0].options.method,'PATCH');assert.equal(JSON.parse(calls[0].options.body).htmlFile,undefined);
  form.values[0]=['id',''];await ui.saveProject({preventDefault(){}});assert.equal(calls.length,1,'new requires file');
  form.elements.htmlFile.files=[{name:'demo.html',size:120}];await ui.saveProject({preventDefault(){}});
  assert.equal(calls.length,2);assert(calls[1].options.body instanceof FormValues);assert(calls[1].options.body.values.has('file'));
  form.elements.htmlFile.files=[{name:'bad.exe',size:120}];await ui.saveProject({preventDefault(){}});assert.equal(calls.length,2);
  console.log('PASS: multipart auth and boundary, metadata-only edit, new upload validation');
})().catch(error=>{console.error(error);process.exitCode=1});
