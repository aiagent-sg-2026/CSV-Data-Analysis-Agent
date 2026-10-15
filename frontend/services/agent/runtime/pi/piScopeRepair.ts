import type {QueryUnderstandingArtifact,GroundingResult,IntentClassificationFindings} from '../intentClassificationTypes';
import type {StoreApi} from '../../types';
import {resolveAnswerScope,type ResolvedAnswerScope} from './queryEvidence';

export const SCOPE_FILTER_GAP='The computation filter has no typed predicate.';
export const canRepairComputationScope=(scope:ResolvedAnswerScope)=>Boolean(scope.computation
    &&scope.unresolved.length===1&&scope.unresolved[0]===SCOPE_FILTER_GAP);
export interface ScopeRepairContext {
    message:string; artifact:QueryUnderstandingArtifact; grounding?:GroundingResult; findings?:IntentClassificationFindings;
}
export interface ScopeRepairProposal {population:'entire_input';goalQuote:string}
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));

/** The model may repair one classifier contradiction, never replace the goal, method or known constraints. */
export const resolveComputationScopeRepair=(context:ScopeRepairContext,proposal:unknown,store:StoreApi):ResolvedAnswerScope=>{
    const current=resolveAnswerScope(context.message,context.artifact,context.grounding,store,context.findings);
    if(!canRepairComputationScope(current))throw new Error('scope_repair_unavailable');
    if(!record(proposal)||Object.keys(proposal).some(key=>!['population','goalQuote'].includes(key))
        ||proposal.population!=='entire_input'||typeof proposal.goalQuote!=='string'
        ||!proposal.goalQuote.trim()||proposal.goalQuote.length>500||!context.message.includes(proposal.goalQuote))throw new Error('scope_repair_proposal_invalid');
    const computation=context.artifact.requestedComputationScope!;
    {
        // A conservative explicit-population quote is required; an absent predicate is not permission to erase a filter.
        const quote=proposal.goalQuote.trim();
        const explicit=/^(?:(?:over|across|for|using|on|from)\s+)?(?:the\s+)?(?:entire input|entire dataset|whole dataset|all rows|all input rows|complete dataset)$|^(?:全部输入|所有输入|所有行|整个数据集)$/i.test(quote);
        const index=context.message.indexOf(proposal.goalQuote),before=context.message.slice(0,index).split(/[.!?\n。！？]/).at(-1)??'';
        const tail=context.message.slice(index+proposal.goalQuote.length);
        const after=tail.split(/[.!?\n。！？]/)[0];
        if(!explicit||!/^\s*(?:$|[,.;!?\n，。；！？])/.test(tail)||/\b(?:not|never|avoid|except|excluding|only|where|unless|without)\b|不|排除|仅/i.test(before+' '+after)
            ||context.artifact.timeScope?.kind!=='none'||!Array.isArray(context.artifact.subjectRefs)||context.artifact.subjectRefs.length)
            throw new Error('scope_repair_explicit_unrestricted_population_required');
    }
    const artifact={...context.artifact,filterDescription:null,
        requestedComputationScope:{...computation,where:undefined}};
    const repaired=resolveAnswerScope(context.message,artifact,context.grounding,store,context.findings);
    if(repaired.unresolved.length||!repaired.computation)throw new Error('scope_repair_requires_clarification');
    return repaired;
};
