import type { StoreApi } from '../agent/types';
import { rootStore,registerSessionResource } from '../session/sessionOwnership';
import type { SpillReadCustody } from './acceptedSpill';
import { spillRow } from './spillCandidateValidation';
import { spillBytes } from './candidateSpill';

type EnvelopeCustody = ReturnType<import('./candidateStaging').CandidateStagingPort['captureDraftRead']>;
const envelopes = new WeakMap<StoreApi['getState'], { custody: EnvelopeCustody; expiresAt: number }>();
/** A bounded immutable snapshot plus revocation checks; deliberately no execution/commit handle. */
export const detachEnvelopeCandidateDraft = (store: StoreApi, custody: EnvelopeCustody) => {
    custody.check(store);
    const key = rootStore(store).getState, entry = { custody, expiresAt: Date.now() + 300000 };
    envelopes.set(key, entry);
    registerSessionResource(store.executionContext!.lease.scope, () => { if (envelopes.get(key) === entry) envelopes.delete(key); });
};
const readers=new WeakMap<StoreApi['getState'],{reviewId:string;reviewDigest:string;expiresAt:number;custody:SpillReadCustody}>();
/** Live-only, read-only custody. No saved projection or ordinary tool call can install this port. */
export const detachCandidateDraft=(store:StoreApi,reviewId:string,reviewDigest:string,expiresAt:number,custody:SpillReadCustody)=>{
    const key=rootStore(store).getState,entry={reviewId,reviewDigest,expiresAt,custody};readers.set(key,entry);
    registerSessionResource(store.executionContext!.lease.scope,()=>{if(readers.get(key)===entry)readers.delete(key);});
};
export const revokeDetachedCandidateDraft=(key:StoreApi['getState'],reviewId:string)=>{if(readers.get(key)?.reviewId===reviewId)readers.delete(key);};
export const readDetachedCandidateDraft=async(store:StoreApi,id:string,tableName:string,digest:string,offset=0,limit=10)=>{
    const key=rootStore(store).getState, envelope = envelopes.get(key);
    // Dispatch by private candidate identity before entering either lane's revocation checks.
    if (envelope?.custody.candidate.candidateId === id) {
        const { custody, expiresAt } = envelope, c = custody.candidate;
        const check = () => {
            try {
                if (envelopes.get(key) !== envelope || Date.now() >= expiresAt) throw new Error('candidate_draft_unavailable');
                custody.check(store);
            } catch (error) {
                if (envelopes.get(key) === envelope) envelopes.delete(key);
                throw error;
            }
        };
        check();
        const table = c.tables.find(t => t.name === tableName);
        if (!table || custody.receipt.receiptDigest !== digest) throw new Error('candidate_draft_unavailable');
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > table.rowCount || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('preview_bounds_invalid');
        const result = { label: 'draft_uncommitted' as const, candidateId: id, tableName, validationReceiptDigest: digest, changeDigest: c.changeDigest,
            sessionId: c.sessionId, sessionEpoch: c.sessionEpoch, protectedSource: c.protectedSource, sourceSha256: c.protectedSource!.sha256,
            sourceVersion: c.protectedSource!.sha256, inputBindings: c.inputBindings, offset, totalRows: table.rowCount,
            rows: [] as typeof table.rows, lineageSamples: [] as typeof table.lineage, truncated: false, lineageTruncated: false, answerEvidence: false as const };
        for (let i = offset; i < Math.min(table.rowCount, offset + limit); i++) {
            result.rows.push(table.rows[i]);
            if (spillBytes(JSON.stringify(result)) > 60 * 1024) { result.rows.pop(); break; }
        }
        if (!result.rows.length && offset < table.rowCount) throw new Error('candidate_preview_row_too_large');
        result.truncated = offset + result.rows.length < table.rowCount;
        for (const lineage of table.lineage) {
            if (lineage.row < offset || lineage.row >= offset + result.rows.length) continue;
            result.lineageSamples.push(lineage);
            if (result.lineageSamples.length > 50 || spillBytes(JSON.stringify(result)) > 63 * 1024) { result.lineageSamples.pop(); result.lineageTruncated = true; break; }
        }
        check(); return result;
    }
    const entry=readers.get(key),c=entry?.custody.candidate;
    if(!entry||!c||c.candidateId!==id||c.tables[0].name!==tableName||entry.custody.receipt.receiptDigest!==digest)throw new Error('candidate_draft_unavailable');
    if(!Number.isSafeInteger(offset)||offset<0||offset>c.tables[0].rowCount||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('preview_bounds_invalid');
    const check=()=>{
        const state=store.getState(),task=state.activeAgentTask,pending=state.pendingClarification??state.activeTurn?.pendingClarificationRequest;
        if(readers.get(key)!==entry||Date.now()>=entry.expiresAt||task?.status!=='awaiting_approval'
            ||pending?.resumeContext?.piCandidateApproval?.reviewId!==entry.reviewId
                &&!(state.candidateRecovery?.proposal.candidateId===id&&state.candidateRecovery.proposal.approval.reviewDigest===entry.reviewDigest))throw new Error('candidate_draft_unavailable');
        entry.custody.check(store);
    };check();
    const result={label:'draft_uncommitted' as const,candidateId:id,tableName,validationReceiptDigest:digest,changeDigest:c.changeDigest,
        sessionId:c.sessionId,sessionEpoch:c.sessionEpoch,protectedSource:c.protectedSource,sourceSha256:c.protectedSource!.sha256,
        sourceVersion:c.protectedSource!.sha256,inputBindings:c.inputBindings,offset,totalRows:c.tables[0].rowCount,
        rows:[] as typeof c.tables[0]['rows'],lineageSamples:[] as typeof c.tables[0]['lineage'],truncated:false,lineageTruncated:false,answerEvidence:false as const};
    let low=0,high=c.spill!.manifest.chunks-1,sequence=0;const row=offset+1;
    while(low<=high){const mid=Math.floor((low+high)/2),chunk=await entry.custody.readChunk(mid,store,check);
        if(row<chunk.startRow)high=mid-1;else if(row>=chunk.nextRow)low=mid+1;else{sequence=mid;break;}}
    const end=Math.min(c.tables[0].rowCount,offset+limit);let full=false;
    for(;sequence<c.spill!.manifest.chunks&&offset+result.rows.length<end&&!full;sequence++){
        const chunk=await entry.custody.readChunk(sequence,store,check);
        for(const raw of chunk.rows){if(raw.sourceRow<=offset||raw.sourceRow>end)continue;
            result.rows.push(spillRow(c.spill!.meaning,raw.cells));
            if(spillBytes(JSON.stringify(result))>60*1024){result.rows.pop();full=true;break;}}
    }
    if(!result.rows.length&&offset<result.totalRows)throw new Error('candidate_preview_row_too_large');
    result.truncated=offset+result.rows.length<result.totalRows;
    for(let i=0;i<result.rows.length;i++)for(const column of c.spill!.meaning.columns){
        result.lineageSamples.push({row:offset+i,column:column.name,origins:[{kind:'source',name:'original',row:offset+i+1,column:column.sourceColumn}]});
        if(result.lineageSamples.length>50||spillBytes(JSON.stringify(result))>63*1024){result.lineageSamples.pop();result.lineageTruncated=true;break;}
    }
    check();return result;
};
