import {webcrypto as crypto,randomUUID,createHash} from 'node:crypto';
const encode=value=>Buffer.from(value).toString('base64url'),decode=value=>Buffer.from(value,'base64url'),utf8=new TextEncoder();
export async function primaryGateway(){
  const origin='https://fleet.fixture.invalid',keys=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  let identity={mode:'active',generation:randomUUID(),realm:origin,publicKey:encode(await crypto.subtle.exportKey('spki',keys.publicKey)),publicSalt:encode(crypto.getRandomValues(new Uint8Array(32))),connected:true};
  identity.fingerprint=createHash('sha256').update(identity.publicKey).digest('hex');
  const receipts=new Map(),transfers=new Map(),requests=[],outer=[];let writes=0,offline=false,lose=false,tamper=false,mode='active',principal='a'.repeat(64),deny=false,held=null;
  const result=(body,status=200,headers={})=>({status,headers:{'content-type':'application/json','x-fleet-principal':principal,'x-fleet-actor':'fixture-owner',...headers},body:JSON.stringify(body)});
  async function business(clear){
    requests.push(clear);const url=new URL(clear.url),body=JSON.parse(clear.body||'{}');
    if(held){const promise=held;held=null;await promise;}
    if(deny)return result({error:'revoked'},401);
    if(url.pathname==='/api/auth/me')return result({user:{id:'fixture-owner',permissions:['*']}});
    if(url.pathname==='/api/auth/user-login')return result({token:'synthetic-token'});
    if(url.pathname.startsWith('/api/native/files/')){
      const action=url.pathname.split('/').pop();
      if(action==='start'){if(!transfers.has(body.id))transfers.set(body.id,{ref:body.id,...body,received:0,bytes:Buffer.alloc(body.size),complete:false});return result(info(transfers.get(body.id)));}
      if(action==='chunk'){const file=transfers.get(body.ref),bytes=Buffer.from(body.data,'base64');if(body.offset!==file.received)return result({error:'offset'},409);bytes.copy(file.bytes,body.offset);file.received+=bytes.length;return result(info(file));}
      if(action==='finish'){const file=transfers.get(body.ref);if(createHash('sha256').update(file.bytes).digest('hex')!==file.sha256)throw Error('upload SHA');file.complete=true;return result(info(file));}
      if(action==='release'){transfers.delete(body.ref);return result({released:true});}
      const file=transfers.get(action),offset=Number(url.searchParams.get('offset')||0),data=file.bytes.subarray(offset,offset+262144);return result({data:data.toString('base64'),offset,length:data.length,size:file.size,sha256:file.sha256});
    }
    if(clear.method!=='GET'){
      const operation=clear.headers['x-fleet-operation'];if(!operation)return result({error:'id required'},428);
      if(receipts.has(operation))return {...receipts.get(operation),headers:{...receipts.get(operation).headers,'x-fleet-replayed':'1'}};
      if(clear.form?.file){const file=transfers.get(clear.form.file.ref);if(!file?.complete)throw Error('unverified multipart');}
      if(clear.bodyFile&&!transfers.get(clear.bodyFile)?.complete)throw Error('unverified JSON');
      writes++;const response=result({saved:true,writes,operation},201);receipts.set(operation,response);return response;
    }
    if(url.pathname==='/api/large'||url.pathname==='/api/pdf'){
      const bytes=url.pathname==='/api/large'?Buffer.from(JSON.stringify({text:'Ελληνικά 🛵'.repeat(180000)})):Buffer.concat([Buffer.from('%PDF-1.7\n'),crypto.getRandomValues(new Uint8Array(65536)),Buffer.alloc(600000,173)]),id=randomUUID(),file={ref:id,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),bytes};transfers.set(id,file);
      const response=result(null);delete response.body;response[url.pathname==='/api/large'?'bodyFile':'file']={ref:id,size:bytes.length,sha256:file.sha256};if(url.pathname==='/api/pdf')response.headers['content-type']='application/pdf';return response;
    }
    return result({rows:[{id:'fixture',amountCents:250}],principal});
  }
  const info=file=>({ref:file.ref,size:file.size,name:file.name,type:file.type,received:file.received,complete:file.complete,sha256:file.sha256});
  async function fetch(input,init){
    const request=new Request(input,init),url=new URL(request.url);outer.push({url:request.url,headers:Object.fromEntries(request.headers),body:request.method==='POST'?await request.clone().text():''});
    if(url.pathname==='/api/primary/descriptor')return Response.json({...identity,mode},{headers:{'X-Fleet-Primary-Protocol':'1'}});
    if(url.pathname!=='/api/primary/request')return Response.json({legacy:true});
    if(offline)return Response.json({error:'offline'},{status:503});
    const packet=await request.json(),other=await crypto.subtle.importKey('spki',decode(packet.epk),{name:'ECDH',namedCurve:'P-256'},false,[]),shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:other},keys.privateKey,256));
    const context='fleet-primary-v1:'+identity.realm+':'+identity.generation+':',key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',Buffer.concat([utf8.encode(context+identity.publicSalt+':'),shared])),'AES-GCM',false,['encrypt','decrypt']),aad=direction=>utf8.encode(context+direction+':'+packet.nonce+':'+packet.epk);
    const clear=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(packet.iv),additionalData:aad('request')},key,decode(packet.ciphertext)))),response=await business(clear);
    if(lose&&clear.method!=='GET'&&!url.pathname.includes('files')){lose=false;return Response.json({error:'lost ACK'},{status:504});}
    const iv=crypto.getRandomValues(new Uint8Array(12)),sealed=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad('response')},key,utf8.encode(JSON.stringify(response)));
    return Response.json({v:1,nonce:tamper?'0'.repeat(32):packet.nonce,epk:packet.epk,iv:encode(iv),ciphertext:encode(sealed)});
  }
  return {origin,identity,fetch,requests,outer,transfers,get writes(){return writes;},set offline(value){offline=value;},set lose(value){lose=value;},set tamper(value){tamper=value;},set mode(value){mode=value;},set principal(value){principal=value;},set deny(value){deny=value;},hold(promise){held=promise;},changeGeneration(){identity={...identity,generation:randomUUID()};this.identity=identity;}};
}
