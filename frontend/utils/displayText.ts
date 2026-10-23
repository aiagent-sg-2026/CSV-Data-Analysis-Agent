/**
 * Shared text helpers for everything a person reads: column labels, counts,
 * plurals and articles. Data and queries keep the real column names; only
 * display text goes through these, so every surface agrees on one wording.
 */

// ── Header layers ("Order :: Date") ─────────────────────────────────────────

/** Intake folds a multi-row header into one column name with this joiner. */
export const HEADER_LAYER_JOINER = ' :: ';
const LAYER_SPLIT_PATTERN = /\s*::\s*/;

export const hasHeaderLayers = (value: string | undefined | null): boolean =>
    typeof value === 'string' && value.includes('::');

export const splitHeaderLayers = (name: string): string[] =>
    name.split(LAYER_SPLIT_PATTERN).map(part => part.trim()).filter(Boolean);

// A leaf like "Date" or "No." says nothing without its band ("Order" / "Delivery").
const QUALIFIER_NEEDING_LEAVES = new Set([
    'date', 'dates', 'no', 'num', 'number', 'code', 'id', 'name', 'type', 'status', 'ref', 'reference', 'time',
]);
// A leaf like "Ordered" or "Outstanding" modifies the band word: "Ordered quantity".
const MODIFIER_LEAVES = new Set(['outstanding', 'open', 'net', 'gross', 'pending', 'overdue', 'current']);

const isModifierLeaf = (leaf: string): boolean => {
    const lower = leaf.toLowerCase();
    return MODIFIER_LEAVES.has(lower) || (/^[a-z]+(?:ed|ing)$/.test(lower) && lower.length > 4);
};

const isPlainWord = (value: string): boolean => /^[A-Za-z]+$/.test(value);
const isAllCaps = (value: string): boolean => value.length > 1 && value === value.toUpperCase();

const lowerFirstWord = (value: string): string =>
    isPlainWord(value) && !isAllCaps(value) ? value.toLowerCase() : value;
const upperFirstChar = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const leafKey = (name: string): string => (splitHeaderLayers(name).slice(-1)[0] ?? name).toLowerCase();

/**
 * One header-layer column name as a person would say it. The leaf alone when it
 * is self-explanatory ("Delivery :: Ship Mode" -> "Ship mode"); the band is kept
 * in natural word order when the leaf alone is ambiguous: a generic leaf
 * ("Order :: Date" -> "Order date"), a modifier ("Quantity :: Ordered" ->
 * "Ordered quantity"), or a leaf another column shares (`peers`).
 */
export const naturalizeColumnName = (name: string, peers: readonly string[] = []): string => {
    if (!hasHeaderLayers(name)) return name;
    const parts = splitHeaderLayers(name);
    if (parts.length === 0) return name.replace(/:+/g, ' ').replace(/\s+/g, ' ').trim();
    if (parts.length === 1) return parts[0];

    const leaf = parts[parts.length - 1];
    const band = parts[parts.length - 2];
    const singleWordLeaf = !/\s/.test(leaf);
    const sharedLeaf = peers.some(peer => peer !== name && hasHeaderLayers(peer) && leafKey(peer) === leaf.toLowerCase());

    if (singleWordLeaf && isModifierLeaf(leaf)) {
        return `${upperFirstChar(leaf)} ${lowerFirstWord(band)}`;
    }
    if (singleWordLeaf && (QUALIFIER_NEEDING_LEAVES.has(leaf.toLowerCase()) || sharedLeaf || isPlainWord(leaf))) {
        return `${band} ${lowerFirstWord(leaf)}`;
    }
    if (!singleWordLeaf && sharedLeaf) {
        return `${band} ${lowerFirstWord(leaf)}`;
    }
    // Digit-bearing leaves such as "Q1" read as the band's own parts ("FY2025 Q1").
    return singleWordLeaf ? `${band} ${leaf}` : leaf;
};

// Free text mentions columns as "Order :: Date" or "Delivery :: Ship Mode, excluding ...":
// one-word band, then a leaf that keeps following capitalised words ("Ship Mode").
const LAYERED_TEXT_PATTERN = /([^\s:()'",;]+)\s::\s([^\s:()'",;]+(?:\s[A-Z][^\s:()'",;]*)*)/g;

/**
 * Replaces header-layer joiners inside a sentence. Columns the caller knows are
 * replaced exactly (longest first); anything left is read by shape.
 */
export const naturalizeLayeredText = (text: string, knownColumns: readonly string[] = []): string => {
    if (!hasHeaderLayers(text)) return text;
    let next = text;
    [...knownColumns]
        .filter(hasHeaderLayers)
        .sort((left, right) => right.length - left.length)
        .forEach(column => {
            next = next.split(column).join(naturalizeColumnName(column, knownColumns));
        });
    if (!hasHeaderLayers(next)) return next;
    // A bare column name (no sentence around it) is read whole, so a multi-word band still works.
    if (!/[.,;()]/.test(next) && next.split('::').length <= 3 && next.trim().split(/\s+/).length <= 6) {
        return naturalizeColumnName(next.trim());
    }
    return next
        .replace(LAYERED_TEXT_PATTERN, match => {
            // Sentence punctuation after the leaf ("... Quantity :: Ordered.") is not part of the name.
            const trailing = match.match(/[.!?]+$/)?.[0] ?? '';
            return `${naturalizeColumnName(trailing ? match.slice(0, -trailing.length) : match)}${trailing}`;
        })
        .replace(/\s*::\s*/g, ' ');
};

// ── Counts and plurals ──────────────────────────────────────────────────────

/** A count shown to a person: thousands separators, never a bare "2040". */
export const formatCount = (value: number | string | null | undefined): string => {
    if (value === null || value === undefined || value === '') return '';
    const numeric = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
    return Number.isFinite(numeric) ? numeric.toLocaleString('en-US') : String(value);
};

const IRREGULAR_PLURALS: Record<string, string> = {
    series: 'series',
    species: 'species',
    news: 'news',
    sales: 'sales',
    person: 'people',
    salesperson: 'salespeople',
    child: 'children',
    man: 'men',
    woman: 'women',
    analysis: 'analyses',
    basis: 'bases',
    index: 'indices',
    matrix: 'matrices',
    datum: 'data',
    criterion: 'criteria',
    half: 'halves',
    life: 'lives',
};

/**
 * Singular nouns that business column names commonly end in; only these (and the suffixes below)
 * get an "s". A name from the user's own data that is not here ("Kunde") is never guessed.
 */
const REGULAR_NOUNS = new Set(`
account address agency agent airline airport album area artist asset author avenue bank batch bill bin block boat book bond brand
branch broker bucket building bus buyer campaign car carrier case category channel chair child city claim class
client club cluster code cohort color colour column company component consultant contact continent contract
contractor country county course currency customer day debtor delivery department deposit depot device district
division doctor document donor dock driver employee entity entry epic estate event exam facility factory family farm
fee film flat flight floor fund game gate genre grade group guest host hospital hotel house household hub industry
intern investor invoice issue item job journal kind label language lease ledger lender lesson level line loan load
location lot machine make mall manager market match material medium member merchant method mill mode model module
month mortgage movie name neighbourhood node nurse order outlet owner package page parish part partner party patient
payment period pilot plan plane plant platform player policy port portfolio position premium price product program
project property province publisher quarter rank receipt record refund region release rep reseller resident role
road room route salesman school season seat sector segment seller sensor server service session shareholder ship storey
shipment shop site size sku song source sprint stage staff station stop store story street student subcategory
subject suburb supplier table tag task team tenant terminal territory ticket tier title tool town train transaction
transfer trip truck type unit user vehicle vendor venue version vessel village visitor voter voucher ward
warehouse week withdrawal worker year zone date
`.split(/\s+/).filter(Boolean));

// Endings that make a word an ordinary English noun even when it is not listed (-ment, -ness, -er ...).
const NOUN_SUFFIX_PATTERN = /(?:tion|sion|ment|ness|ity|ance|ence|ship|ory|ery|ist|ee|er|or|ure)$/;

const isUpper = (value: string): boolean => value === value.toUpperCase();

/** Plural of one English word; leaves words that already read as plural alone. */
export const pluralizeWord = (word: string): string => {
    if (!/^[A-Za-z]+$/.test(word)) return word;
    const lower = word.toLowerCase();
    const match = (plural: string) => (isUpper(word) && word.length > 1 ? plural.toUpperCase()
        : word[0] === word[0].toUpperCase() ? upperFirstChar(plural) : plural);
    if (IRREGULAR_PLURALS[lower]) return match(IRREGULAR_PLURALS[lower]);
    if (/(ss|sh|ch|x|z)$/.test(lower)) return `${word}${isUpper(word) ? 'ES' : 'es'}`;
    if (/us$/.test(lower)) return `${word}${isUpper(word) ? 'ES' : 'es'}`;
    if (/is$/.test(lower)) return `${word.slice(0, -2)}${isUpper(word) ? 'ES' : 'es'}`;
    if (/[^aeiou]y$/.test(lower)) return `${word.slice(0, -1)}${isUpper(word) ? 'IES' : 'ies'}`;
    // "Customers", "Items": already plural, never "Customerses".
    if (/s$/.test(lower)) return word;
    return `${word}${isUpper(word) ? 'S' : 's'}`;
};

/**
 * True when the word is one this helper can pluralise with confidence: a known
 * irregular, a known common noun, or already plural. A word from a user's own
 * column name ("Kunde") is none of these.
 */
export const isPluralizableWord = (word: string): boolean => {
    const lower = word.toLowerCase();
    return Boolean(IRREGULAR_PLURALS[lower]) || REGULAR_NOUNS.has(lower) || /^[a-z]+s$/.test(lower)
        || (lower.length > 4 && NOUN_SUFFIX_PATTERN.test(lower));
};

/**
 * Plural of a column-derived label ("Customer" -> "Customers", "Parent Series"
 * stays "Parent Series"), or null when its last word is not a word we know.
 * A name taken from the user's data must never get a guessed "s" ("kundes").
 */
export const pluralizeLabelOrNull = (label: string): string | null => {
    const words = label.trim().split(/\s+/);
    const last = words[words.length - 1];
    if (!last || !/^[A-Za-z]+$/.test(last) || !isPluralizableWord(last)) return null;
    words[words.length - 1] = pluralizeWord(last);
    return words.join(' ');
};

/** The neutral plural for a label we cannot pluralise. */
export const NEUTRAL_GROUPS_WORD = 'groups';

/** Count-aware word for fixed app nouns: pluralizeCount(1, 'card') -> 'card', (2, 'card') -> 'cards'. */
export const pluralizeCount = (count: number, singular: string, plural?: string): string =>
    count === 1 ? singular : (plural ?? pluralizeWord(singular));

/** "1 card", "2 cards", "2,040 groups". */
export const formatCountNoun = (count: number, singular: string, plural?: string): string =>
    `${formatCount(count)} ${pluralizeCount(count, singular, plural)}`;

// ── Articles ────────────────────────────────────────────────────────────────

/** "a" or "an" for a number read aloud: "an 8", "an 826", "an 18,000", "a 17", "a 110". */
export const articleForNumber = (value: number | string): 'a' | 'an' => {
    const digits = String(value).replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
    if (!digits) return 'a';
    if (digits.startsWith('8')) return 'an';
    if (digits.length % 3 === 2 && (digits.startsWith('11') || digits.startsWith('18'))) return 'an';
    return 'a';
};

/** "an 826", "a 140". */
export const withNumberArticle = (value: number | string, formatted?: string): string =>
    `${articleForNumber(value)} ${formatted ?? value}`;

/**
 * Fixes the article before a number in prose ("creating a 826 spread" -> "an 826 spread").
 * Model-written sentences get this wrong often, and no prompt rule makes it reliable.
 */
export const fixNumberArticles = (text: string): string =>
    text.replace(/\b([Aa])(n?)\s+(\d[\d,]*(?:\.\d+)?)/g, (_match, letter: string, _n: string, number: string) =>
        `${letter}${articleForNumber(number) === 'an' ? 'n' : ''} ${number}`);

/**
 * Last-mile polish for model-written prose: header layers ("Order :: Date") read naturally and
 * the article before a number is right. Everything else the model wrote is left alone.
 */
export const polishGeneratedProse = (text: string | null | undefined): string => {
    if (!text) return '';
    return fixNumberArticles(hasHeaderLayers(text) ? naturalizeLayeredText(text) : text);
};
