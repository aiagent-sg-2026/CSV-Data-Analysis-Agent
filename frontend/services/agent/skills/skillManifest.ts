import type { Skill } from '@earendil-works/pi-agent-core';
export interface SkillSupportFile {
    path: string;
    kind: 'guidance' | 'javascript';
    sha256: string;
}
export interface SkillManifest {
    schemaVersion: 1;
    version: string;
    profiles: Array<'browser-javascript' | 'browser-python' | 'full'>;
    requires: string[];
    supportingFiles: SkillSupportFile[];
}
export interface AppSkill extends Skill {
    manifest?: SkillManifest;
}
const exact = (value: unknown, keys: string[]) => Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|'));
export const validSkillSupportPath = (path: unknown): path is string => typeof path === 'string' && path.length <= 160
    && /^[a-zA-Z0-9._/-]+$/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
    && !path.startsWith('/') && path !== 'SKILL.md';
/** The optional inline JSON manifest extends existing frontmatter without a YAML dependency. */
export const parseSkillManifest = (raw: string | undefined): SkillManifest | undefined => {
    if (raw === undefined)
        return undefined;
    let value: SkillManifest;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('skill_manifest_invalid');
    }
    if (!exact(value, ['schemaVersion', 'version', 'profiles', 'requires', 'supportingFiles']) || value.schemaVersion !== 1
        || typeof value.version !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(value.version)
        || !Array.isArray(value.profiles) || value.profiles.length > 3 || new Set(value.profiles).size !== value.profiles.length
        || value.profiles.some(p => !['browser-javascript', 'browser-python', 'full'].includes(p))
        || !Array.isArray(value.requires) || value.requires.length > 20 || new Set(value.requires).size !== value.requires.length
        || value.requires.some(c => typeof c !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(c))
        || !Array.isArray(value.supportingFiles) || value.supportingFiles.length > 16
        || new Set(value.supportingFiles.map(f => f?.path)).size !== value.supportingFiles.length
        || value.supportingFiles.some(f => !exact(f, ['path', 'kind', 'sha256']) || !validSkillSupportPath(f.path)
            || !['guidance', 'javascript'].includes(f.kind) || !/^([a-f0-9]{64})$/.test(f.sha256)
            || (f.kind === 'javascript' && !f.path.endsWith('.js'))))
        throw new Error('skill_manifest_invalid');
    return value;
};
export const skillManifest = (skill: AppSkill): SkillManifest => skill.manifest ?? {
    schemaVersion: 1, version: 'legacy', profiles: [], requires: [], supportingFiles: [],
};
