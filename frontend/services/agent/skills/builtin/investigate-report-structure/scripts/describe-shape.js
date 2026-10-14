// Observations only: no repairs, evidence admission or host access.
const rows = input.data.rows;
if (!Array.isArray(rows)) throw new TypeError('Expected a complete table named data.');
const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
return {
    rowCount: rows.length,
    columns: columns.map(column => ({
        name: column,
        missing: rows.filter(row => row[column] == null || row[column] === '').length,
        types: [...new Set(rows.map(row => row[column] === null ? 'null' : typeof row[column]))],
    })),
    purpose: 'Structural observations; these do not establish business meaning or accepted evidence.',
};
