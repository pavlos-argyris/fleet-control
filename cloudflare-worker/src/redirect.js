// The former cloud origin has no business authority or proxy capability.
export const DIRECT_ORIGIN='https://fleet-control.duckdns.org';
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
function retired(){return new Response('Fleet Control: use the Direct Android Server.',{status:410,headers});}
export default {fetch(request){
  // Fixed destination: discard the old path/query/fragment. No fetch,
  // forwarded session/credentials or redirect of API writes.
  if(request.method==='GET'||request.method==='HEAD')return new Response(null,{status:302,headers:{...headers,Location:DIRECT_ORIGIN+'/'}});
  return retired();
}};
// Preserve the existing class/namespace/migration identity and its stored data.
// Old alarms or hibernated sockets must not resume cloud business operations.
export class FleetEvents{
  fetch(){return retired();}
  alarm(){}
  webSocketMessage(socket){socket.close(1000,'Direct Server');}
  webSocketClose(){}
  webSocketError(){}
}
