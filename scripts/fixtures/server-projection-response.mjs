// Prepared response fixtures for general UI/layout suites. Payroll correctness
// is exercised separately through actual Java + Worker/D1 in the Ordexa suite.
export function serverProjectionResponse(path,generic,payroll){
 const projection={fresh:true,sourceFresh:true,readOnly:false,computedAt:new Date().toISOString(),sourceSyncedAt:new Date().toISOString(),weekStart:generic.currentWeek?.startDate||'2026-10-19'};
 if(path==='/api/admin/ordexa-server/dashboard')return {projection,alerts:{total:generic.actionCount||0,service:generic.actionGroups?.service||0},data:{workingNow:generic.today?.workingNow||0,vehiclesInUse:Array.from({length:generic.today?.vehicles?.in_use||0},(_,i)=>({id:'bike-'+i,name:generic.bikes?.[i]?.name||'Μηχανάκι '+(i+1)})),totalVehicles:(generic.today?.vehicles?.available||0)+(generic.today?.vehicles?.in_use||0),missingClockIns:[],activeShifts:[],pendingClockOuts:[],dailySchedule:[],weekStart:projection.weekStart,weekEnd:generic.currentWeek?.endDate||'2026-10-25',payableHours:generic.currentWeek?.payableHours||0,payrollCents:generic.currentWeek?.payrollCents||0,coverage:{days:[],summary:{}}}};
 if(path==='/api/admin/ordexa-server/shifts')return {projection,shifts:[]};
 if(path==='/api/admin/ordexa-server/employee-links')return {riders:[]};
 if(path==='/api/admin/ordexa-server/payroll'||path==='/api/admin/ordexa-server/estimate')return {projection,period:{id:'fixture-period',status:'open'},data:{...payroll,period:{...payroll?.period,hoursSource:'ordexa',status:'open'},hoursSource:'ordexa',employees:(payroll?.employees||[]).map(p=>({...p,employeeId:p.employeeId||'e',sourceRows:p.sourceRows||[]})),blockers:[],ordexaReviews:[],serverComputed:true}};
 return null;
}
