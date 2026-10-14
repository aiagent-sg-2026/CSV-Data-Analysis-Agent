import {describe,expect,it} from 'vitest';
import type {Report,DatasetBundle} from '../types';
import type {DatasetCommitMarker,DatasetCommitRecord} from '../types/datasetCommit';
import {commitHeadKey} from '../types/datasetCommit';
import {projectCommittedReport,reconcileReportCommit} from '../services/persistence/datasetCommitProjection';
import {replayDatasetBundlePrograms} from '../services/data/datasetBundleReplay';
const marker={kind:'commit',recordId:'marker',sessionId:'session',commitId:'commit-1',revision:1,
    bundle:{datasetVersion:'accepted-v2',acceptedCommit:{sessionId:'session',commitId:'commit-1',revision:1},tables:[],transformationPrograms:[]}} as unknown as DatasetCommitMarker;
const report={id:'session',appState:{sessionId:'session',datasetBundle:{datasetVersion:'old'},csvData:{fileName:'input.csv',data:[{Amount:999}]},
    rawCsvData:{fileName:'input.csv',data:[{Amount:999}]},canonicalCsvData:{fileName:'input.csv',data:[{Amount:999}]},analysisCards:[{id:'historical'}],
    chatHistory:[{id:'historical-chat'}],activeDataQuery:{id:'old'},datasetSemanticSnapshot:{id:'old'},workspaceFiles:{'/dataset/cleaned.csv':'999','/workspace/dataset/clean.csv':'999','/workspace/program.js':'program'}}} as unknown as Report;
describe('durable commit projections',()=>{
    it.each(['session','current_session','archive-session'])('reconciles stale %s snapshots without persisting rows or restoring authority',async(id)=>{
        const records=new Map<string,DatasetCommitRecord>([[commitHeadKey('session'),{kind:'head',recordId:commitHeadKey('session'),sessionId:'session',commitId:'commit-1',revision:1,markerKey:'marker'}],['marker',marker]]);
        const restored=await reconcileReportCommit({get:async key=>records.get(key)},{...report,id});
        expect(restored.appState.datasetBundle?.datasetVersion).toBe('accepted-v2');expect(restored.appState.datasetCommitBindingStatus).toBe('awaiting_source');
        expect(restored.appState.csvData).toBeNull();expect(restored.appState.rawCsvData).toBeNull();expect(restored.appState.canonicalCsvData).toBeNull();expect(restored.appState.activeDataQuery).toBeNull();
        expect(restored.appState.analysisCards).toEqual(report.appState.analysisCards);expect(restored.appState.chatHistory).toEqual(report.appState.chatHistory);
        expect(restored.appState.workspaceFiles).toEqual({'/workspace/program.js':'program'});expect(report.appState.csvData!.data[0].Amount).toBe(999);
    });
    it('keeps a separate session and legacy reports intact',async()=>{
        expect(await reconcileReportCommit({get:async()=>undefined},report)).toBe(report);
    });
    it('refuses a broken head instead of restoring a pre-commit dataset',async()=>{
        await expect(reconcileReportCommit({get:async()=>({kind:'head',markerKey:'missing'} as DatasetCommitRecord)},report)).rejects.toThrow('commit_marker_invalid');
    });
    it('resolves a History fork against the pinned original commit instead of its later head',async()=>{
        const fork={...report,appState:{...report.appState,sessionId:'fork',datasetBundle:marker.bundle}};
        const restored=await reconcileReportCommit({get:async()=>undefined,index:()=>({getAll:async()=>[marker]})},fork);
        expect(restored.appState.datasetBundle?.acceptedCommit?.commitId).toBe('commit-1');expect(restored.appState.csvData).toBeNull();
        await expect(reconcileReportCommit({get:async()=>undefined,index:()=>({getAll:async()=>[]})},fork)).rejects.toThrow('commit_marker_invalid');
    });
    it('does not replay committed generated code through the legacy deterministic-operation fallback',()=>{
        expect(replayDatasetBundlePrograms({bundle:marker.bundle as DatasetBundle,currentData:report.appState.csvData!})).toMatchObject({status:'fresh_import_required',reasonCodes:['committed_dataset_requires_verified_recovery']});
        expect(projectCommittedReport(report,marker).appState.datasetBundle?.acceptedCommit?.commitId).toBe('commit-1');
    });
});
