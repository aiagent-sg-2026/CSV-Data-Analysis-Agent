import {parseSkillManifest,type AppSkill} from './skillManifest';

export interface SkillParseDiagnostic {
    path: string;
    message: string;
}

/** Exactly one of `skill` and `diagnostic` is set. */
export interface SkillParseResult {
    skill: AppSkill | null;
    diagnostic: SkillParseDiagnostic | null;
}

const FRONTMATTER_FENCE = '---';
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1_024;

const isValidSkillName = (name: string): boolean =>
    name.length > 0
    && name.length <= MAX_NAME_LENGTH
    && Array.from(name).every(char => (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '-');

const parseBoolean = (value: string | undefined): boolean => value?.trim().toLowerCase() === 'true';

/**
 * Parses a `SKILL.md` document: a small frontmatter block (`name`, `description`,
 * optional `disable-model-invocation`) followed by the instructions. The format
 * matches the pi agent harness, so skills can be shared with other pi tooling.
 */
export const parseSkillMarkdown = (text: string, filePath: string): SkillParseResult => {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const fail = (message: string): SkillParseResult => ({ skill: null, diagnostic: { path: filePath, message } });

    if (lines[0]?.trim() !== FRONTMATTER_FENCE) return fail('The skill file must start with a "---" frontmatter block.');
    const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE);
    if (closingIndex < 0) return fail('The frontmatter block is not closed with "---".');

    const fields = new Map<string, string>();
    for (const line of lines.slice(1, closingIndex)) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        const key=line.slice(0,separator).trim().toLowerCase();
        if(fields.has(key))return fail('Duplicate skill frontmatter field.');
        fields.set(key, line.slice(separator + 1).trim());
    }

    const name = fields.get('name') ?? '';
    const description = fields.get('description') ?? '';
    if (!isValidSkillName(name)) return fail('The skill name must be 1-64 characters of lowercase letters, digits and hyphens.');
    if (!description) return fail('The skill needs a description that says when to use it.');
    if (description.length > MAX_DESCRIPTION_LENGTH) return fail(`The description is longer than ${MAX_DESCRIPTION_LENGTH} characters.`);

    const content = lines.slice(closingIndex + 1).join('\n').trim();
    if (!content) return fail('The skill has no instructions after the frontmatter.');
    const restriction=fields.get('disable-model-invocation');
    if(restriction!==undefined&&!/^(true|false)$/i.test(restriction))return fail('Invalid model-invocation restriction.');
    let manifest:AppSkill['manifest'];
    try {manifest=parseSkillManifest(fields.get('manifest'));}catch{return fail('skill_manifest_invalid');}

    return {
        diagnostic: null,
        skill: {
            name,
            description,
            content,
            filePath,
            ...(manifest?{manifest}:{}),
            ...(parseBoolean(fields.get('disable-model-invocation')) ? { disableModelInvocation: true } : {}),
        },
    };
};

/** The `SKILL.md` text for a skill, so it can be exported or edited and parses back to the same skill. */
export const serializeSkillMarkdown = (skill: AppSkill): string => [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    ...(skill.disableModelInvocation ? ['disable-model-invocation: true'] : []),
    ...(skill.manifest?['manifest: '+JSON.stringify(skill.manifest)]:[]),
    '---',
    '',
    skill.content,
    '',
].join('\n');
