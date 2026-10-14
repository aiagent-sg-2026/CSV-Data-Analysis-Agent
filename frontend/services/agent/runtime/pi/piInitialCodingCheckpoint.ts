import type {AppState} from '../../../../types';
import type {DatasetCommitMarker} from '../../../../types/datasetCommit';
import type {PiInitialCheckpointV2} from './piInitialCheckpoint';
import {captureCheckpointSource,checkpointLineageSignature} from './piInitialCheckpoint';
import {DEFAULT_TASK_LIMITS,restoreTaskBudget,type TaskBudget} from './piTaskBudget';
import {verifyReplayManifest} from '../../../data/datasetRecovery';
import {getCsvDatasetVersion} from '../../../../utils/datasetId';

/** Journal truth can close only the exact cleaning publication boundary, never another uncertain stage. */
export const verifyInitialCodingCommit=async(checkpoint:PiInitialCheckpointV2,marker:DatasetCommitMarker)=>{
    if(!checkpoint.coding||marker.sessionId!==checkpoint.sessionId||!marker.taskBudget)throw new Error('initial_commit_mismatch');
    await verifyReplayManifest(marker);
    const source=marker.bundle.source;
    if(source.fileName!==checkpoint.source.fileName||source.fingerprint!==checkpoint.source.fingerprint||source.byteSize!==checkpoint.source.byteSize
        ||marker.replayManifest?.validationBinding.goal!==checkpoint.researchGoal)throw new Error('initial_commit_mismatch');
    if(checkpoint.pendingStageIndex!==null){
        if(![2,3].includes(checkpoint.pendingStageIndex)||marker.audit.taskId!==checkpoint.executorPreparation?.taskId)throw new Error('stage_side_effects_uncertain');
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
        stageReceipts:pending?[...checkpoint.stageReceipts,{stageIndex:3,toolName:'dataset.applyTransform',inputVersion:checkpoint.datasetVersion,
            outputVersion:marker.bundle.datasetVersion,decision:'pass',transformationIds:[marker.commitId],cardIds:[]}]:checkpoint.stageReceipts,
        coding:{version:1,budget,commit:marker.bundle.acceptedCommit!}};
};
