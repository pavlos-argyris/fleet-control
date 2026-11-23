(function(root){
  'use strict';const encoder=new TextEncoder(),MAX_CLEAR=1400000;
  const encode=value=>{let text='';for(const byte of new Uint8Array(value))text+=String.fromCharCode(byte);return btoa(text).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');};
  function decode(value,max=2097152){if(typeof value!=='string'||value.length>max||!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Μη έγκυρο ασφαλές πακέτο Server.');return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
  const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?encoder.encode(value):value)),b=>b.toString(16).padStart(2,'0')).join('');
  const context=value=>'fleet-primary-v1:'+value.realm+':'+value.generation+':';
  async function descriptor(value,origin){
    if(!value||!['cloud','preparing','aborting','active','recovering','returning'].includes(value.mode))throw Error('Δεν επιβεβαιώθηκε το πρωτόκολλο της κύριας βάσης.');
    if(value.mode!=='active')return value;
    if(value.realm!==origin||!origin.startsWith('https://')||!/^[a-f0-9-]{36}$/.test(value.generation||'')||!/^[-_A-Za-z0-9]{122}$/.test(value.publicKey||'')||!/^[-_A-Za-z0-9]{43}$/.test(value.publicSalt||'')||!/^([a-f0-9]){64}$/.test(value.fingerprint||'')||await hash(value.publicKey)!==value.fingerprint)throw Error('Δεν συμφωνεί η ταυτότητα της κύριας βάσης.');
    await crypto.subtle.importKey('spki',decode(value.publicKey),{name:'ECDH',namedCurve:'P-256'},false,[]);return value;
  }
  async function cloudReturn(value,identity){
    const c=value?.cloudReturn;if(value?.mode!=='cloud'||value.backend!=='cloud-sqlite'||!c||c.realm!==identity.realm||c.sourceGeneration!==identity.generation||c.targetId!==value.cloudBusiness||!/^[a-f0-9-]{36}$/.test(c.targetId||'')||!/^[a-f0-9]{64}$/.test(c.inventoryHash||'')||await hash(identity.publicKey)!==identity.fingerprint)return false;
    try{const key=await crypto.subtle.importKey('spki',decode(identity.publicKey),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);return await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decode(c.signature,86),encoder.encode('fleet-cloud-return-v1|'+identity.realm+'|'+identity.generation+'|'+c.targetId+'|'+c.inventoryHash));}catch{return false;}
  }
  async function seal(identity,request){
    const keys=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']),other=await crypto.subtle.importKey('spki',decode(identity.publicKey),{name:'ECDH',namedCurve:'P-256'},false,[]),shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:other},keys.privateKey,256));
    const prefix=encoder.encode(context(identity)+identity.publicSalt+':'),material=new Uint8Array(prefix.length+shared.length);material.set(prefix);material.set(shared,prefix.length);
    let digest;try{digest=await crypto.subtle.digest('SHA-256',material);}finally{shared.fill(0);material.fill(0);}
    const key=await crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['encrypt','decrypt']);new Uint8Array(digest).fill(0);
    const nonce=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''),epk=encode(await crypto.subtle.exportKey('spki',keys.publicKey)),iv=crypto.getRandomValues(new Uint8Array(12));
    const aad=direction=>encoder.encode(context(identity)+direction+':'+nonce+':'+epk),plain=encoder.encode(JSON.stringify({...request,sentAt:Date.now()}));if(plain.length>MAX_CLEAR)throw Error('Το αίτημα χρειάζεται τμηματική μεταφορά αρχείου.');
    let ciphertext;try{ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad('request'),tagLength:128},key,plain);}finally{plain.fill(0);}
    return {packet:{v:1,nonce,epk,iv:encode(iv),ciphertext:encode(ciphertext)},async open(value){
      if(value?.v!==1||value.nonce!==nonce||value.epk!==epk||typeof value.iv!=='string'||value.iv.length!==16)throw Error('Η ασφαλής απάντηση ανήκει σε άλλο αίτημα.');
      const clear=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(value.iv,16),additionalData:aad('response'),tagLength:128},key,decode(value.ciphertext)));
      try{if(clear.length>MAX_CLEAR)throw Error('Μεγάλη ασφαλής απάντηση Server.');const result=JSON.parse(new TextDecoder().decode(clear));if(!Number.isInteger(result.status)||result.status<200||result.status>599||!result.headers||typeof result.headers!=='object')throw Error('Μη έγκυρη ασφαλής απάντηση.');return result;}finally{clear.fill(0);}
    }};
  }
  root.FleetPrimaryCrypto={seal,descriptor,cloudReturn,hash,encode,decode,MAX_CLEAR};
})(globalThis);
