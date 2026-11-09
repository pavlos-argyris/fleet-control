/** Retry transient download failures without weakening the caller's size, digest
 * or certificate verification of the exact pinned release asset. */
export async function fetchReleaseReference(url,{fetcher=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms)),attempts=4}={}){
  let failure;
  for(let attempt=0;attempt<attempts;attempt++){
    try{const response=await fetcher(url,{signal:AbortSignal.timeout(120000)});if(response.ok||![429,500,502,503,504].includes(response.status)||attempt===attempts-1)return response;await response.body?.cancel();failure=Error('Temporary release HTTP '+response.status);}
    catch(error){failure=error;if(attempt===attempts-1)throw error;}
    await pause(Math.min(1000*2**attempt,8000));
  }throw failure;
}
