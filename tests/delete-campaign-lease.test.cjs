const fs=require("node:fs");const test=require("node:test");const assert=require("node:assert/strict");
const source=fs.readFileSync("src/index.ts","utf8");
const reg=source.slice(source.indexOf('\n\t\tthis.server.registerTool(\n\t\t\t"meta_delete_campaign"'));
const start=reg.indexOf("async ({ campaign_id, confirmation_phrase, expected_campaign_name }) => {");
const end=reg.indexOf("\n\t\t\t},\n\t\t);",start)+"\n\t\t\t}".length;
const callback=reg.slice(start,end).replace("this.env as MetaEnv","this.env");
function harness(fail){
 const calls=[];let locked=false;
 const before={id:"123",name:"Finished",account_id:"acct"};
 const dependencies={
 assertWritesEnabled:()=>{calls.push("gate");if(fail==="gate")throw Error("disabled");},
 getOwnedObject:async()=>{calls.push("read-owned");return before;},
 assertExpectedName:(_b,name)=>{calls.push("name");if(name!=="Finished")throw Error("wrong name");},
 assertConfirmation:(actual,expected)=>{calls.push("confirmation");assert.equal(actual,expected);},
 acquireAccountWriteLease:async(_env,owner)=>{calls.push("acquire:"+owner);if(fail==="acquire")throw Error("WRITE_LOCKED");locked=true;},
 writeResponseSchema:{parse:x=>x},
 callMetaGraph:async(_env,method,id,body)=>{calls.push("post");assert(locked);assert.equal(method,"POST");assert.equal(id,"123");assert.deepEqual(body,{status:"DELETED"});if(fail==="post")throw Error("Meta rejected");return {success:true};},
 auditMutation:(kind)=>calls.push(kind),
 asToolResult:x=>({ok:true,...x}),
 asToolError:x=>({ok:false,error:x.message}),
 releaseAccountOperationLease:async(_env,owner)=>{calls.push("release:"+owner);assert.equal(owner,"same-session");assert(locked);locked=false;return fail==="release-warning"?"release warning":undefined;}
 };
 const context={env:{},ctx:{id:{toString:()=> "same-session"}}};
 const handler=new Function(...Object.keys(dependencies),"return "+callback).call(context,...Object.values(dependencies));
 return {calls,invoke:args=>handler(args),get locked(){return locked;}};
}
const good={campaign_id:"123",expected_campaign_name:"Finished",confirmation_phrase:"DELETE CAMPAIGN 123 Finished"};
test("confirmed deletion releases only its own lease before returning",async()=>{const h=harness();const r=await h.invoke(good);assert.equal(r.result.success,true);assert.equal(r.status_requested,"DELETED");assert.equal(h.locked,false);assert.deepEqual(h.calls.slice(-3),["post","delete_campaign","release:same-session"]);});
test("Meta failure still releases acquired lease",async()=>{const h=harness("post");const r=await h.invoke(good);assert.equal(r.ok,false);assert.equal(h.locked,false);assert.equal(h.calls.at(-1),"release:same-session");});
test("another owner's lease is never released",async()=>{const h=harness("acquire");const r=await h.invoke(good);assert.equal(r.error,"WRITE_LOCKED");assert(!h.calls.some(x=>x.startsWith("release")));assert(!h.calls.includes("post"));});
test("name mismatch never acquires or releases a lease",async()=>{const h=harness();const r=await h.invoke({...good,expected_campaign_name:"Different"});assert.equal(r.ok,false);assert(!h.calls.some(x=>x.startsWith("acquire")||x.startsWith("release")));});
test("confirmation mismatch never acquires or posts",async()=>{const h=harness();const r=await h.invoke({...good,confirmation_phrase:"wrong"});assert.equal(r.ok,false);assert(!h.calls.some(x=>x.startsWith("acquire")||x==="post"));});
test("release warning preserves successful deletion receipt and is logged",async()=>{const h=harness("release-warning");const r=await h.invoke(good);assert.equal(r.result.success,true);assert.equal(h.calls.at(-1),"delete_campaign_lease_release_warning");});

