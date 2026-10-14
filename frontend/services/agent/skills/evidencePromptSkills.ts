import { resolveSkillEntries } from './skillRegistry';
import {assertPinnedSkillCurrent,skillAvailability} from './skillSnapshot';
import type {StoreApi} from '../types';

// The evidence planner is a single model call with no tools, so it cannot use `read_skill`.
// Instead the full text of the skills that govern how a question is measured is placed in its
// prompt. Skills the person added in Settings are included too, so their rules reach this stage.
const EVIDENCE_STAGE_BUILTIN_SKILLS = ['choose-metric-and-aggregation', 'explore-with-data-query'] as const;
const MAX_GUIDANCE_CHARS = 6_000;

/** Guidance text for the evidence query planner, or an empty string when no skill applies. */
export const buildEvidenceSkillGuidance = (
    userSkillSources?: Record<string, string>,
    store?:StoreApi,
): string => {
    const entries=store?.piTask?store.piTask.skills.entries:resolveSkillEntries(undefined,userSkillSources).entries;
    const chosen = entries.filter(({ skill, source, enabled }) =>
        enabled
        && !skill.disableModelInvocation
        && (store?.piTask?true:!skill.manifest?.profiles.length&&!skill.manifest?.requires.length&&!skill.manifest?.supportingFiles.length)
        && (source !== 'builtin' || (EVIDENCE_STAGE_BUILTIN_SKILLS as readonly string[]).includes(skill.name)));
    const parts: string[] = [];
    let used = 0;
    for (const entry of chosen) {
        const {skill}=entry;
        if(store?.piTask){
            const pin=store.piTask.skills.entries.find(p=>p===entry)!;
            assertPinnedSkillCurrent(store,pin);
            if(!skillAvailability(store,pin).available)continue;
        }
        const pin=store?.piTask?.skills.entries.find(p=>p===entry);
        const block = `### Skill: ${skill.name}\n${pin?`Pinned version: ${pin.manifest.version}; SHA-256: ${pin.sha256}\n`:''}${skill.content}`;
        if (used + block.length > MAX_GUIDANCE_CHARS) continue;
        parts.push(block);
        used += block.length;
    }
    if (parts.length === 0) return '';
    return [
        'Analysis skills (guidance for how to measure and query; they never override the topic, the real columns or the output schema):',
        ...parts,
    ].join('\n\n');
};
