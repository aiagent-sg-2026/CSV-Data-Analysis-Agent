import {json,sha256} from './fixtureKit.mjs';

/** Evaluator-only schedule projection. No oracle values or arbitrary fault programs enter the browser. */
export const frozenFaultPolicy=schedule=>{
  if(!Array.isArray(schedule))throw new Error('fault_schedule_invalid');
  if(schedule.length===0)return undefined;
  if(json(schedule)!==json([{execution:1,observation:'injected_program_or_schema_failure',requires:'bounded_revision'}]))throw new Error('fault_schedule_invalid');
  return {scheduleSha256:sha256(json(schedule)),executions:[1]};
};

export const hasFrozenFaultRecovery=(schedule,evidence)=>{
  const policy=frozenFaultPolicy(schedule);
  if(!policy)return true;
  if(evidence?.scheduleSha256!==policy.scheduleSha256||!Array.isArray(evidence.receipts)||evidence.receipts.length>40)return false;
  const receipts=evidence.receipts,failed=receipts.filter(r=>r.environment?.evaluationFault?.scheduleSha256===policy.scheduleSha256);
  if(failed.length!==1)return false;
  const first=failed[0],fault=first.environment.evaluationFault;
  if(fault.kind!=='program_failure'||fault.execution!==1||first.status!=='failed'||first.reasonCode!=='guest_program_failed'
    ||!first.program?.sha256||first.output||!first.workerGenerations?.length||first.error?.message!=='Execution failed at the runtime boundary.')return false;
  return receipts.some(r=>r.status==='succeeded'&&r.program?.sha256!==first.program.sha256&&r.taskId===first.taskId
    &&r.sessionId===first.sessionId&&r.sessionEpoch===first.sessionEpoch&&r.startedAt>=first.finishedAt&&!r.environment?.evaluationFault);
};
