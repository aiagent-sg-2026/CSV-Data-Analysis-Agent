/** Integrity evidence uses SHA-256; legacy dataset IDs remain compatible identifiers. */
export const sha256Bytes = async (bytes: Uint8Array): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};
