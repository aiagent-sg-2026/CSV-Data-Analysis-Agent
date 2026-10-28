import type {AppState} from '../../../../types';
import type {DatasetCommitMarker} from '../../../../types/datasetCommit';
import type {PiInitialCheckpointV2} from './piInitialCheckpoint';
import {captureCheckpointSource,checkpointLineageSignature} from './piInitialCheckpoint';
import {DEFAULT_TASK_LIMITS,restoreTaskBudget,type TaskBudget} from './piTaskBudget';
import {verifyReplayManifest} from '../../../data/datasetRecovery';
import {getCsvDatasetVersion} from '../../../../utils/datasetId';

/** A full original-source repair commit can replace unresolved intake stages. Saved stage numbers
 * alone never do: the verified journal must prove the same task's exact source-only publication.
 */
const isSourceRepairCommit=(marker:DatasetCommitMarker)=>{
    const manifest=marker.replayManifest,source=manifest?.source,request=manifest?.request;
    return Boolean(source&&request&&!request.tables?.length&&request.sources?.length===1
        &&request.sources[0].sourceId===source.sourceId&&request.sources[0].sha256===source.sha256
        &&request.sources[0].offset===0&&request.sources[0].length===source.byteSize
        &&manifest.validationBinding.inference?.input.kind==='source'&&marker.validation.decision==='validated');
};

/** Journal truth can close only exact cleaning/source-repair publication, not arbitrary uncertain stages. */
export const verifyInitialCodingCommit=async(checkpoint:PiInitialCheckpointV2,marker:DatasetCommitMarker)=>{
    if(!checkpoint.coding||marker.sessionId!==checkpoint.sessionId||!marker.taskBudget)throw new Error('initial_commit_mismatch');
    await verifyReplayManifest(marker);
    const source=marker.bundle.source;
    if(source.fileName!==checkpoint.source.fileName||source.fingerprint!==checkpoint.source.fingerprint||source.byteSize!==checkpoint.source.byteSize
        ||marker.replayManifest?.validationBinding.goal!==checkpoint.researchGoal)throw new Error('initial_commit_mismatch');
    if(checkpoint.pendingStageIndex!==null){
        const sourceRepair=checkpoint.pendingStageIndex===0&&checkpoint.nextStageIndex===0&&isSourceRepairCommit(marker);
        if((!sourceRepair&&![2,3].includes(checkpoint.pendingStageIndex))||marker.audit.taskId!==checkpoint.executorPreparation?.taskId)throw new Error('stage_side_effects_uncertain');
    }else if(checkpoint.coding.commit?.commitId!==marker.commitId||checkpoint.coding.commit.revision!==marker.revision
        ||checkpoint.coding.commit.sessionId!==marker.sessionId)throw new Error('initial_commit_mismatch');
    const budgets=[checkpoint.coding.budget,marker.taskBudget].map(restoreTaskBudget);
    if(budgets.some(b=>Object.entries(b.limits).some(([k,v])=>v>DEFAULT_TASK_LIMITS[k as keyof typeof DEFAULT_TASK_LIMITS])))throw new Error('task_budget_invalid');
    const result:TaskBudget={limits:{...budgets[0].limits},used:{...budgets[0].used},pausedForUser:false};
    for(const key of Object.keys(result.used) as Array<keyof typeof result.used>){
        result.limits[key]=Math.min(...budgets.map(b=>b.limits[key]));result.used[key]=Math.max(...budgets.map(b=>b.used[key]));
    }
    return restoreTaskBudget(result);
};

export const reconcileInitialCodingCheckpoint=async(checkpoint:PiInitialCheckpointV2,state:AppState,marker:DatasetCommitMarker):Promise<PiInitialCheckpointV2>=>{
    const budget=await verifyInitialCodingCommit(checkpoint,marker);
    if(state.datasetCommitBindingStatus!=='ready'||state.datasetBundle?.acceptedCommit?.commitId!==marker.commitId
        ||!state.csvData||getCsvDatasetVersion(state.csvData)!==marker.bundle.datasetVersion
        ||JSON.stringify(captureCheckpointSource(state))!==JSON.stringify(checkpoint.source))throw new Error('committed_dataset_not_bound');
    const pending=checkpoint.pendingStageIndex!==null;
    return {...checkpoint,nextStageIndex:pending?4:checkpoint.nextStageIndex,pendingStageIndex:null,
        datasetVersion:marker.bundle.datasetVersion,preparedDatasetVersion:marker.bundle.datasetVersion,
        lineageSignature:checkpointLineageSignature(state),committedTransformationIds:[...new Set([...checkpoint.committedTransformationIds,marker.commitId])],
        ...(pending&&checkpoint.pendingStageIndex===0?{receiptStartIndex:4,stageReceipts:[],warnings:[]}:{stageReceipts:pending?[...checkpoint.stageReceipts,{stageIndex:3,toolName:'dataset.applyTransform',inputVersion:checkpoint.datasetVersion,
            outputVersion:marker.bundle.datasetVersion,decision:'pass' as const,transformationIds:[marker.commitId],cardIds:[]}]:checkpoint.stageReceipts}),
        coding:{version:1,budget,commit:marker.bundle.acceptedCommit!}};
};
