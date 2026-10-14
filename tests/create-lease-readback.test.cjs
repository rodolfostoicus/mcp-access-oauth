const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const source = fs.readFileSync("src/index.ts", "utf8");
function callback(tool) {
 const start = source.indexOf('"' + tool + '"');
 const end = source.indexOf("\n\t\tthis.server.registerTool(", start + 1);
 const section = source.slice(start, end < 0 ? undefined : end);
 const a = section.indexOf("async ({");
 const z = section.lastIndexOf("\n\t\t\t},\n\t\t);") + "\n\t\t\t}".length;
 return section.slice(a, z)
  .replace(/ as MetaEnv/g, "")
  .replace(/: Record<string, string \| number \| boolean \| object>/g, "")
  .replace(/: Record<string, unknown>/g, "");
}
function harness(tool, failure) {
 const kind = tool === "meta_create_campaign_draft" ? "CAMPAIGN" : tool === "meta_create_adset_draft" ? "ADSET" : "AD";
 const calls = []; let locked = false; let cached;
 const input = {name:"New draft",objective:"OUTCOME_ENGAGEMENT",special_ad_categories:[],request_id:"a6b5a7d0-3216-4e7c-9276-32122de5702f",validate_only:false,
  campaign_id:"456",expected_campaign_name:"Parent campaign",adset_id:"789",expected_adset_name:"Parent adset",billing_event:"IMPRESSIONS",
  optimization_goal:"POST_ENGAGEMENT",destination_type:"ON_POST",targeting:{age_min:26,age_max:55},page_id:"321",headline:"Course",
  message:"Course details",description:"Course",link_url:"https://example.com/course",image_hash:"abc",call_to_action_type:"LEARN_MORE"};
 input.confirmation_phrase = kind === "CAMPAIGN" ? "CREATE CAMPAIGN New draft" : kind === "ADSET" ? "CREATE ADSET 456 New draft" : "CREATE AD 789 New draft";
 const deps = {
  URL: class { constructor(value) { this.hostname = value.split("/")[2]; } },
  assertWritesEnabled:()=>{},
  getMetaConfig:()=>({accountId:"act_123"}),
  getOwnedObject:async(_env, type, id)=>{
   calls.push("read:"+type+":"+id);
   if(id!=="987")return {id,name:type==="CAMPAIGN"?"Parent campaign":"Parent adset",destination_type:"WEBSITE",promoted_object:{page_id:"321"},objective:"OUTCOME_ENGAGEMENT"};
   if(failure==="readback")throw Error("readback unavailable");
   return {id,name:"New draft",status:failure==="status"?"ACTIVE":"PAUSED",campaign_id:failure==="parent"?"000":"456",adset_id:failure==="parent"?"000":"789"};
  },
  assertExpectedName:(obj, expected)=>{assert.equal(obj.name,expected);},
  assertConfirmation:(actual, expected)=>{assert.equal(actual,expected);},
  acquireAccountWriteLease:async(_env, holder)=>{calls.push("acquire:"+holder);if(failure==="locked")throw Error("WRITE_LOCKED");locked=true;},
  runIdempotentCreate:async(_env,_operation,_request,create)=>{if(cached)return {idempotent_replay:true,result:cached};cached=await create();return {idempotent_replay:false,result:cached};},
  writeResponseSchema:{parse:x=>x},
  callMetaGraph:async()=>{calls.push("post");assert(locked);if(failure==="post")throw Error("unknown POST result");return failure==="missing-id"?{success:true}:{id:"987"};},
  auditMutation:()=>{},
  asToolResult:x=>({ok:true,...x}),
  asToolError:e=>({ok:false,error:e.message}),
  setOptionalBudget:()=>{},
  getPromotedPageId:x=>x.promoted_object.page_id,
  releaseAccountOperationLease:async(_env,holder)=>{calls.push("release:"+holder);assert.equal(holder,"same-call");assert(locked);locked=false;return failure==="release-warning"?"release warning":undefined;}
 };
 const context={env:{},ctx:{id:{toString:()=>"same-call"}}};
 const handler=new Function(...Object.keys(deps),"return "+callback(tool)).call(context,...Object.values(deps));
 return {input,calls,invoke:overrides=>handler({...input,...overrides}),get locked(){return locked;}};
}
for(const tool of ["meta_create_campaign_draft","meta_create_adset_draft","meta_create_ad_draft"]){
 test(tool+" releases only after confirmed PAUSED read-back",async()=>{const h=harness(tool);const r=await h.invoke();assert.equal(r.verified,true);assert.equal(h.locked,false);assert.equal(h.calls.at(-1),"release:same-call");assert(h.calls.some(x=>x.endsWith(":987")));});
 test(tool+" preserves idempotent replay without another POST",async()=>{const h=harness(tool);await h.invoke();const r=await h.invoke();assert.equal(r.idempotent_replay,true);assert.equal(h.calls.filter(x=>x==="post").length,1);});
 for(const failure of ["post","readback","status","missing-id"])test(tool+" retains lease on "+failure,async()=>{const h=harness(tool,failure);const r=await h.invoke();assert.equal(r.ok,false);assert.equal(h.locked,true);assert(!h.calls.some(x=>x.startsWith("release")));});
 test(tool+" never releases another owner's lease",async()=>{const h=harness(tool,"locked");const r=await h.invoke();assert.equal(r.ok,false);assert(!h.calls.includes("post"));assert(!h.calls.some(x=>x.startsWith("release")));});
 test(tool+" refuses wrong confirmation before lease or POST",async()=>{const h=harness(tool);const r=await h.invoke({confirmation_phrase:"wrong"});assert.equal(r.ok,false);assert(!h.calls.some(x=>x.startsWith("acquire")));assert(!h.calls.includes("post"));});
 test(tool+" returns a release warning without hiding verified creation",async()=>{const h=harness(tool,"release-warning");const r=await h.invoke();assert.equal(r.verified,true);assert.equal(r.write_lease_release_warning,"release warning");});
 if(tool!=="meta_create_campaign_draft")test(tool+" retains lease on a changed parent",async()=>{const h=harness(tool,"parent");const r=await h.invoke();assert.equal(r.ok,false);assert.equal(h.locked,true);assert(!h.calls.some(x=>x.startsWith("release")));});
}
