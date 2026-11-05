/* Web primitives needed by the shared business handlers. No network/file/Java globals. */
const native=(command,data={})=>JSON.parse(globalThis.__fleetNative(command,JSON.stringify(data)));
globalThis.FleetHost=native;
if(!Object.hasOwn)Object.hasOwn=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
if(!Array.prototype.at)Object.defineProperty(Array.prototype,'at',{value:function(index){return this[index<0?this.length+index:index];}});
if(!String.prototype.replaceAll)Object.defineProperty(String.prototype,'replaceAll',{value:function(find,replacement){return typeof find==='string'?this.split(find).join(replacement):this.replace(find,replacement);}});
const bytes=value=>value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new TextEncoder().encode(String(value??''));
const hex=value=>Array.from(bytes(value),n=>n.toString(16).padStart(2,'0')).join('');
const fromHex=value=>Uint8Array.from(String(value).match(/../g)||[],s=>parseInt(s,16));
globalThis.TextEncoder=class{encode(value=''){const data=unescape(encodeURIComponent(String(value)));return Uint8Array.from(data,c=>c.charCodeAt(0));}};
globalThis.TextDecoder=class{constructor(label='utf-8'){if(!/^utf-?8$/i.test(label))throw Error('Unsupported encoding');}decode(value){if(value===undefined)return '';let result='';for(const b of bytes(value))result+=String.fromCharCode(b);try{return decodeURIComponent(escape(result));}catch{return native('utf8.decode',{hex:hex(value)}).text;}}};
globalThis.btoa=value=>native('base64.encode',{text:String(value)}).text;
globalThis.atob=value=>native('base64.decode',{text:String(value)}).text;
globalThis.crypto={
 getRandomValues(array){const data=fromHex(native('crypto.random',{length:array.byteLength}).hex);new Uint8Array(array.buffer,array.byteOffset,array.byteLength).set(data);return array;},
 randomUUID(){const b=this.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const s=hex(b);return s.slice(0,8)+'-'+s.slice(8,12)+'-'+s.slice(12,16)+'-'+s.slice(16,20)+'-'+s.slice(20);},
 subtle:{
  async importKey(format,key,algorithm,extractable,usages){if(format!=='raw')throw Error('Unsupported key format');return {raw:hex(key),algorithm,usages};},
  async digest(algorithm,data){return fromHex(native('crypto.digest',{algorithm:typeof algorithm==='string'?algorithm:algorithm.name,hex:hex(data)}).hex).buffer;},
  async deriveBits(algorithm,key,length){return fromHex(native('crypto.derive',{algorithm:algorithm.name,hash:algorithm.hash,key:key.raw,salt:hex(algorithm.salt),iterations:algorithm.iterations,length}).hex).buffer;},
  async sign(algorithm,key,data){return fromHex(native('crypto.sign',{algorithm:typeof algorithm==='string'?algorithm:algorithm.name,key:key.raw,hex:hex(data)}).hex).buffer;},
  async verify(algorithm,key,signature,data){return native('crypto.verify',{algorithm:typeof algorithm==='string'?algorithm:algorithm.name,key:key.raw,hex:hex(data),signature:hex(signature)}).valid===true;}
 }
};
globalThis.URLSearchParams=class{
 constructor(value=''){this.entriesList=[];if(typeof value==='string'){for(const part of value.replace(/^\?/,'').split('&'))if(part){const at=part.indexOf('=');this.append(decodeURIComponent((at<0?part:part.slice(0,at)).replace(/\+/g,' ')),decodeURIComponent((at<0?'':part.slice(at+1)).replace(/\+/g,' ')));}}else if(value&&typeof value[Symbol.iterator]==='function'){for(const [key,item] of value)this.append(key,item);}else for(const [key,item] of Object.entries(value||{}))this.append(key,item);}
 append(key,value){this.entriesList.push([String(key),String(value)]);}
 set(key,value){this.delete(key);this.append(key,value);}
 get(key){return this.entriesList.find(e=>e[0]===String(key))?.[1]??null;}
 getAll(key){return this.entriesList.filter(e=>e[0]===String(key)).map(e=>e[1]);}
 has(key){return this.entriesList.some(e=>e[0]===String(key));}
 delete(key){this.entriesList=this.entriesList.filter(e=>e[0]!==String(key));}
 toString(){return this.entriesList.map(([k,v])=>encodeURIComponent(k).replace(/%20/g,'+')+'='+encodeURIComponent(v).replace(/%20/g,'+')).join('&');}
 *entries(){yield* this.entriesList;}*[Symbol.iterator](){yield* this.entriesList;}*keys(){for(const e of this.entriesList)yield e[0];}*values(){for(const e of this.entriesList)yield e[1];}
 forEach(fn,thisArg){for(const [k,v] of this.entriesList)fn.call(thisArg,v,k,this);}
};
globalThis.URL=class{
 constructor(value,base){const info=native('url.parse',{value:String(value),base:base===undefined?null:String(base)});Object.assign(this,info);this.searchParams=new URLSearchParams(info.search);}
 toString(){return this.origin+this.pathname+(this.searchParams.toString()?'?'+this.searchParams:'')+this.hash;}
 get href(){return this.toString();}get search(){return this.searchParams?'?'+this.searchParams.toString():this._search;}set search(value){this._search=value;if(this.searchParams)this.searchParams=new URLSearchParams(value);}
};
globalThis.Headers=class{
 constructor(value){this.items=new Map();if(value instanceof Headers)for(const pair of value)this.append(...pair);else if(Array.isArray(value))for(const pair of value)this.append(...pair);else for(const [k,v]of Object.entries(value||{}))this.append(k,v);}
 get(key){return this.items.get(String(key).toLowerCase())??null;}has(key){return this.items.has(String(key).toLowerCase());}set(key,value){this.items.set(String(key).toLowerCase(),String(value));}append(key,value){const old=this.get(key);this.set(key,old?old+', '+value:value);}delete(key){this.items.delete(String(key).toLowerCase());}
 *entries(){yield* this.items;}*[Symbol.iterator](){yield* this.items;}*keys(){yield* this.items.keys();}*values(){yield* this.items.values();}forEach(fn,thisArg){for(const [k,v]of this.items)fn.call(thisArg,v,k,this);}
};
class NativeFile{
 constructor(ref){Object.assign(this,ref);this.__file=true;this.size=Number(ref.size||0);this.type=ref.type||'application/octet-stream';this.name=ref.name||'file';}
 async arrayBuffer(){return fromHex(native('file.read',{ref:this.ref,start:0,length:this.size}).hex).buffer;}
 slice(start=0,end=this.size,type=this.type){return new NativeFile({...this,ref:native('file.slice',{ref:this.ref,start,end}).ref,size:Math.max(0,end-start),type});}
 async text(){return new TextDecoder().decode(await this.arrayBuffer());}
}
globalThis.File=NativeFile;
globalThis.Blob=class{
 constructor(parts=[],options={}){const all=parts.map(bytes),length=all.reduce((s,b)=>s+b.length,0);this.data=new Uint8Array(length);let at=0;for(const b of all){this.data.set(b,at);at+=b.length;}this.size=length;this.type=options.type||'';}
 async arrayBuffer(){return this.data.buffer;}async text(){return new TextDecoder().decode(this.data);}slice(a=0,b=this.size,type=this.type){return new Blob([this.data.slice(a,b)],{type});}
};
const streamBody=data=>({__fleetStream:true,data,getReader(){let read=false;return{async read(){if(read)return{done:true};read=true;return{done:false,value:bytes(data)};},async cancel(){read=true;}};}});
globalThis.Request=class{
 constructor(value,options={}){const old=value instanceof Request?value:null;this.url=old?old.url:String(value);this.method=String(options.method||old?.method||'GET').toUpperCase();this.headers=new Headers(options.headers||old?.headers);this.data=Object.hasOwn(options,'body')?options.body:old?.data;if(this.data?.__fleetStream)this.data=this.data.data;this.form=options.form||old?.form;this.signal=options.signal;this.redirect=options.redirect||old?.redirect||'follow';}
 get body(){return this.data==null?null:streamBody(this.data);}async text(){return this.data==null?'':typeof this.data==='string'?this.data:new TextDecoder().decode(this.data);}async json(){return JSON.parse(await this.text());}async arrayBuffer(){return bytes(this.data||'').buffer;}
 async formData(){const map=new Map();for(const [key,value]of Object.entries(this.form||{}))map.set(key,value&&value.ref?new NativeFile(value):String(value));return map;}clone(){return new Request(this);}
};
globalThis.Response=class{
 constructor(body=null,options={}){this.data=body?.__fleetStream?body.data:body;this.status=options.status??200;this.statusText=options.statusText||'';this.headers=new Headers(options.headers);this.ok=this.status>=200&&this.status<300;}
 get body(){return this.data?.__file?this.data: this.data==null?null:streamBody(this.data);}async text(){if(this.data==null)return '';if(typeof this.data==='string')return this.data;if(typeof this.data.text==='function')return this.data.text();return new TextDecoder().decode(this.data);}async json(){return JSON.parse(await this.text());}async arrayBuffer(){return this.data&&typeof this.data.arrayBuffer==='function'?this.data.arrayBuffer():bytes(this.data||'').buffer;}clone(){return new Response(this.data,{status:this.status,headers:this.headers});}
 static json(value,options={}){return new Response(JSON.stringify(value),{...options,headers:{'Content-Type':'application/json; charset=utf-8',...Object.fromEntries(new Headers(options.headers))}});}static redirect(url,status=302){return new Response(null,{status,headers:{Location:String(url)}});}
};
globalThis.Intl={DateTimeFormat:class{
 constructor(locale,options={}){this.locale=locale||'en-CA';this.options=options;}
 formatToParts(value){return native('date.parts',{at:Number(new Date(value)),zone:this.options.timeZone||'UTC'}).parts;}
 format(value){const p=Object.fromEntries(this.formatToParts(value).map(v=>[v.type,v.value]));if(this.options.hour&&!this.options.year)return p.hour+(this.options.minute?':'+p.minute:'')+(this.options.second?':'+p.second:'');return p.year+'-'+p.month+'-'+p.day;}
}};
globalThis.performance={now:()=>native('clock',{}).millis};
globalThis.console={log(){},info(){},warn(){},error(){native('diagnostic',{code:'business-handler-error'});}};
globalThis.fetch=async(value,options)=>{const req=new Request(value,options);const result=native('http.read',{url:req.url,method:req.method,headers:Object.fromEntries(req.headers)});return new Response(result.body??'',{status:result.status,headers:result.headers});};
globalThis.AbortController=class{constructor(){this.signal={aborted:false};}abort(){this.signal.aborted=true;}};
globalThis.AbortSignal={timeout:()=>({aborted:false})};
export {bytes,hex,fromHex,NativeFile};
