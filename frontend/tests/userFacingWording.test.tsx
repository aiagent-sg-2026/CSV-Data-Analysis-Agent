import fs from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AnalysisCardSummary } from '../components/analysis-card/AnalysisCardSummary';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { createFallbackReportContext, isUsableReportTitle, verifyAiExtractedReportContext } from '../services/agent/reportContext';
import {
    buildColumnDisplayLabels,
    resolveDisplayPlanDescription,
    resolveDisplayPlanTitle,
    resolvePlanGroupLabel,
    resolvePlanMetricLabel,
} from '../services/dashboard/businessLabelResolver';
import { buildExecutiveKpis } from '../services/dashboard/executiveKpis';
import { normalizeDisplayLabel, pluralizeLabel, toDisplayLabel } from '../services/dashboard/executiveKpiUtils';
import { buildNarrativeAnalysisIrInputList } from '../services/dashboard/displayAnalysisNarrative';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { buildCsvDataFromIntakeIr } from '../services/data/reportCsvIntake';
import { getAnalysisColumnLabels, roundRowsToDisplayPrecision } from '../utils/analysisCardPresentation';
import { setBandColumnLabels, syncBandColumnLabels } from '../utils/bandLabels';
import {
    articleForNumber,
    fixNumberArticles,
    formatCount,
    naturalizeColumnName,
    naturalizeLayeredText,
    pluralizeWord,
    polishGeneratedProse,
} from '../utils/displayText';
import { getTranslation, getTranslationEntries } from '../utils/localization';
import type { AnalysisCardData, CsvData } from '../types';

const LANGUAGES = ['English', 'Mandarin', 'Japanese', 'Malay'] as const;
const LEAKS: Array<[string, RegExp]> = [
    ['a "::" header-layer joiner', /::/],
    ['"serieses"', /serieses/i],
    ['a "(s)" plural hedge', /\(s\)/],
];
const expectNoLeaks = (text: string, where: string) => {
    for (const [name, pattern] of LEAKS) {
        expect(text, `${where} shows ${name}`).not.toMatch(pattern);
    }
};

const loadFixture = async (fileName: string) => {
    const text = fs.readFileSync(path.resolve(process.cwd(), 'tests/fixtures/weird-reports', fileName), 'utf8');
    const file = { name: fileName, size: text.length, text: async () => text } as unknown as File;
    const { csvData, intakeIr } = await processCsvWithIntakeIr(file);
    return { csvData, rawCsvData: { ...buildCsvDataFromIntakeIr(intakeIr), fileName } as CsvData };
};

afterEach(() => {
    cleanup();
    setBandColumnLabels({});
});

describe('header layers read naturally in every label', () => {
    let w1: Awaited<ReturnType<typeof loadFixture>>;
    let w6: Awaited<ReturnType<typeof loadFixture>>;
    beforeAll(async () => {
        w1 = await loadFixture('w1_erp_outstanding.csv');
        w6 = await loadFixture('w6_grouped_header_carryforward.csv');
    });

    it('names the layered columns of the w1 ERP report as a person would', () => {
        const columns = Object.keys(w1.csvData.data[0]!);
        expect(columns).toEqual(expect.arrayContaining(['Order :: Date', 'Delivery :: Date', 'Quantity :: Ordered', 'Delivery :: Ship Mode']));
        const labels = buildColumnDisplayLabels(columns);
        expect(labels['Order :: Date']).toBe('Order Date');
        expect(labels['Delivery :: Date']).toBe('Delivery Date');
        expect(labels['Quantity :: Ordered']).toBe('Ordered Quantity');
        expect(labels['Delivery :: Ship Mode']).toBe('Ship Mode');
        Object.values(labels).forEach(label => expectNoLeaks(label, 'a browser column label'));
    });

    it('keeps the qualifier when two columns share the leaf', () => {
        expect(naturalizeColumnName('Order :: Date')).toBe('Order date');
        expect(naturalizeColumnName('Delivery :: Date')).toBe('Delivery date');
        expect(naturalizeColumnName('Region :: Total', ['Region :: Total', 'City :: Total'])).toBe('Region total');
        // A self-explanatory leaf stands alone.
        expect(naturalizeColumnName('Delivery :: Ship Mode')).toBe('Ship Mode');
        expect(naturalizeColumnName('Amount :: Balance Amount')).toBe('Balance Amount');
        expect(naturalizeColumnName('FY2025 :: Q1')).toBe('FY2025 Q1');
    });

    const layeredCard = (groupByColumn: string, valueColumn: string, rows: Array<[string, number]>) => ({
        id: 'card-layered',
        plan: {
            title: `Total ${valueColumn} by ${groupByColumn}`,
            description: `Sum ${valueColumn} for each ${groupByColumn}.`,
            chartType: 'bar',
            aggregation: 'sum',
            groupByColumn,
            valueColumn,
        },
        aggregatedData: rows.map(([group, value]) => ({ [groupByColumn]: group, [valueColumn]: value })),
        summary: { language: 'English', text: 'Summary' },
        displayChartType: 'bar',
        isDataVisible: false,
        topN: null,
        hideOthers: false,
        hiddenLabels: [],
        provenance: {
            schemaVersion: 1, datasetId: 'd', datasetVersion: 'v', evidenceStatus: 'verified', evidenceReasons: [],
            method: { operation: 'bar', groupByColumns: [groupByColumn], aggregations: [], sourceColumns: [], filterCount: 0, pivotRows: [], pivotColumns: [] },
            queryEvidence: null, queryEvidenceRequired: false, evidenceRefs: [], createdAt: '2026-07-25T00:00:00.000Z',
        },
        autoAnalysisEvaluation: { verdict: 'trusted', reasonCodes: [], detail: 'trusted', evaluatedAt: new Date().toISOString(), source: 'auto_analysis_evaluator_v1' },
    }) as unknown as AnalysisCardData;

    const kpisFor = (card: AnalysisCardData) => buildExecutiveKpis({
        cards: [card],
        columnProfiles: [
            { name: card.plan.groupByColumn!, type: 'categorical', uniqueValues: 3, missingPercentage: 0 },
            { name: card.plan.valueColumn!, type: 'numerical', missingPercentage: 0, valueRange: [100, 700] },
        ],
        csvData: { fileName: 'w1.csv', data: card.aggregatedData },
        language: 'English',
    });

    it('labels executive KPIs of a layered category column without "::"', () => {
        const kpis = kpisFor(layeredCard('Delivery :: Ship Mode', 'Quantity :: Ordered', [['COURIER', 700], ['TRUCK', 200], ['AIR', 100]]));
        const byId = Object.fromEntries(kpis.map(kpi => [kpi.id, kpi]));
        expect(byId['top-group'].label).toBe('Top Ship Mode');
        expect(byId['group-count'].label).toBe('Distinct Ship Modes');
        expect(byId['total-metric'].label).toBe('Total Ordered Quantity');
        expect(byId['total-metric'].delta?.label).toBe('held by top Ship Mode');
        expect(byId['top-share']?.detail ?? '').toBe('Share held by the leading 3 ship modes.');
        kpis.forEach(kpi => expectNoLeaks(`${kpi.label} ${kpi.detail} ${kpi.delta?.label ?? ''} ${kpi.scope.label}`, `KPI ${kpi.id}`));
    });

    it('labels executive KPIs of a layered date column without "::"', () => {
        const kpis = kpisFor(layeredCard('Order :: Date', 'Quantity :: Ordered', [['2026-01-05', 700], ['2026-01-06', 200], ['2026-01-07', 100]]));
        const byId = Object.fromEntries(kpis.map(kpi => [kpi.id, kpi]));
        expect(byId['top-group'].label).toBe('Top Order Date');
        expect(byId['group-count'].label).toBe('Distinct Order Dates');
        kpis.forEach(kpi => expectNoLeaks(`${kpi.label} ${kpi.detail} ${kpi.delta?.label ?? ''} ${kpi.scope.label}`, `KPI ${kpi.id}`));
    });

    it('titles a card on layered columns without "::"', () => {
        const plan = {
            title: 'Total Ordered Quantity by Order :: Date',
            description: 'Measure the trend by summing Quantity :: Ordered for each Order :: Date.',
            groupByColumn: 'Order :: Date',
            valueColumn: 'Quantity :: Ordered',
        };
        expect(resolveDisplayPlanTitle(plan)).toBe('Ordered Quantity by Order Date');
        expect(resolveDisplayPlanDescription(plan)).toContain('Ordered quantity for each Order date');
        expectNoLeaks(resolveDisplayPlanDescription(plan), 'the card description');
        // The data keeps its real names.
        expect(plan.groupByColumn).toBe('Order :: Date');
        const free = resolveDisplayPlanTitle({ ...plan, groupByColumn: 'Something', title: 'Median of Delivery :: Ship Mode, excluding blanks' });
        expect(free).not.toContain('::');
    });

    it('uses one label for column headers of a card table', () => {
        const labels = getAnalysisColumnLabels(['Order :: Date', 'Quantity :: Ordered'], {
            title: 'Ordered by date', description: '', groupByColumn: 'Order :: Date', valueColumn: 'Quantity :: Ordered', aggregation: 'sum',
        });
        expect(labels).toEqual({ 'Order :: Date': 'Order Date', 'Quantity :: Ordered': 'Ordered Quantity' });
    });

    it('names the w6 header bands without the joiner', () => {
        const columns = Object.keys(w6.csvData.data[0]!);
        const labels = buildColumnDisplayLabels(columns);
        expect(labels['FY2025 :: Q1']).toBe('FY2025 Q1');
        Object.values(labels).forEach(label => expectNoLeaks(label, 'a w6 column label'));
    });

    it('naturalizes narrative text and model prose', () => {
        expect(naturalizeLayeredText('Top 8 of Order :: Date by Quantity :: Ordered.')).toBe('Top 8 of Order date by Ordered quantity.');
        expect(naturalizeLayeredText('Median of Delivery :: Ship Mode, excluding blanks')).toBe('Median of Ship Mode, excluding blanks');
        expect(polishGeneratedProse('1.1% held by top Order :: Date')).toBe('1.1% held by top Order date');
    });
});

describe('plurals never read as bugs', () => {
    it('keeps "series" and "species" as they are', () => {
        expect(pluralizeWord('series')).toBe('series');
        expect(pluralizeWord('Species')).toBe('Species');
        expect(pluralizeLabel('Parent Series')).toBe('Parent Series');
        expect(pluralizeLabel(toDisplayLabel('ParentSeries', 'Group'))).toBe('Parent Series');
        expect(getTranslation('executive_kpi_total_detail_groups', 'English', { count: 8, groups: pluralizeLabel('Parent Series').toLowerCase() }))
            .toBe('Across 8 parent series.');
    });

    it('does not append "s" to a label that is the user\'s own column name', () => {
        expect(pluralizeLabel('Kunde')).toBe('Groups');
        expect(pluralizeLabel('kunde')).toBe('groups');
        expect(pluralizeLabel('Customer')).toBe('Customers');
        expect(pluralizeLabel('Customers')).toBe('Customers');
        expect(pluralizeLabel('Currency')).toBe('Currencies');
        expect(pluralizeLabel('Salesperson')).toBe('Salespeople');
    });

    it('words KPI details from a foreign column name neutrally', () => {
        const detail = getTranslation('executive_kpi_top_share_detail', 'English', { count: 3, groups: pluralizeLabel('kunde') });
        expect(detail).toBe('Share held by the leading 3 groups.');
    });

    it('says "1 data quality note" and "1 layer" in the singular and keeps the plural otherwise', () => {
        expect(getTranslation('data_warnings_compact_summary', 'English', { count: 1 })).toMatch(/^1 data quality note ·/);
        expect(getTranslation('data_warnings_compact_summary', 'English', { count: 4 })).toMatch(/^4 data quality notes ·/);
        expect(getTranslation('boundary_confirm_header_depth_unit', 'English', { count: 1 })).toBe('1 layer');
        expect(getTranslation('boundary_confirm_header_depth_unit', 'English', { count: 3 })).toBe('3 layers');
        expect(getTranslation('evidence_summary_note', 'English', { count: 1 })).toContain('1 evidence card.');
        expect(getTranslation('evidence_summary_note', 'English', { count: 4 })).toContain('4 evidence cards.');
        // A formatted count still selects the singular.
        expect(getTranslation('history_older_versions', 'English', { count: '1' })).toBe('+1 previous version');
    });

    it('has no "(s)" hedge, "serieses" or "::" in any English, Mandarin, Japanese or Malay text', () => {
        for (const [key, entry] of getTranslationEntries()) {
            for (const language of LANGUAGES) {
                const text = entry[language];
                if (!text) continue;
                expectNoLeaks(text, `${key} (${language})`);
            }
        }
    });

    it('keeps every label helper free of leaks for representative names in all four languages', () => {
        const names = ['Order :: Date', 'Delivery :: Date', 'Quantity :: Ordered', 'Delivery :: Ship Mode', 'Parent Series', 'ParentSeries', 'Kunde', 'CCY', 'SeriesLabelL1', 'FY2025 :: Q1'];
        for (const language of LANGUAGES) {
            for (const name of names) {
                const label = toDisplayLabel(name, 'Group');
                const plural = pluralizeLabel(label);
                const plan = { title: `Total by ${name}`, description: `Compare ${name}.`, groupByColumn: name, valueColumn: name };
                const surfaces = [
                    label,
                    plural,
                    normalizeDisplayLabel(`Top ${name} by ${name} (median of ${name})`, 'x'),
                    resolvePlanGroupLabel(plan),
                    resolvePlanMetricLabel(plan) ?? '',
                    resolveDisplayPlanTitle(plan),
                    resolveDisplayPlanDescription(plan),
                    getTranslation('executive_kpi_top_group_label', language, { group: label }),
                    getTranslation('executive_kpi_group_count_label', language, { groups: plural }),
                    getTranslation('executive_kpi_group_count_detail', language, { groups: plural }),
                    getTranslation('executive_kpi_top_share_detail', language, { count: 3, groups: plural }),
                    getTranslation('executive_kpi_delta_distribution', language, { group: label }),
                    getTranslation('executive_kpi_inactive_label', language, { groups: plural }),
                ];
                surfaces.forEach(text => expectNoLeaks(text, `${language} ${name}`));
            }
        }
    });
});

describe('a melted band column reads as what its values are', () => {
    const bandRows = (values: string[]) => values.map(value => ({ SeriesLabelL1: value, Value: 1 }));

    it('calls FY values a fiscal year and quarter values a quarter', () => {
        syncBandColumnLabels(bandRows(['FY2025', 'FY2026', 'FY2025']));
        expect(resolvePlanGroupLabel({ title: 'Typical Value by Series Label 1', description: '', groupByColumn: 'SeriesLabelL1', valueColumn: 'Value' })).toBe('Fiscal Year');
        expect(resolveDisplayPlanTitle({ title: 'Typical Value by Series Label 1', description: '', groupByColumn: 'SeriesLabelL1', valueColumn: 'Value' })).toBe('Typical Value by Fiscal Year');

        syncBandColumnLabels(bandRows(['Q1', 'Q2', 'Q3', 'Q4']));
        expect(resolvePlanGroupLabel({ title: 'Value by SeriesLabelL1', description: '', groupByColumn: 'SeriesLabelL1', valueColumn: 'Value' })).toBe('Quarter');

        syncBandColumnLabels(bandRows(['North', 'South']));
        expect(resolvePlanGroupLabel({ title: 'Value by SeriesLabelL1', description: '', groupByColumn: 'SeriesLabelL1', valueColumn: 'Value' })).toBe('Group');
    });

    it('uses the same label in the research question text and keeps its closing parenthesis', () => {
        syncBandColumnLabels(bandRows(['FY2025', 'FY2026']));
        const question = normalizeDisplayLabel('Typical Value by SeriesLabelL1 (median of Value by SeriesLabelL1)', 'x');
        expect(question).toBe('Typical Value by Fiscal year (median of Value by Fiscal year)');
        expect(normalizeDisplayLabel('Category differences in typical Value (median of Value by Category)', 'x')).toMatch(/Category\)$/);
        expect(question).not.toMatch(/series label/i);
        expect(buildColumnDisplayLabels(['SeriesLabelL1'])['SeriesLabelL1']).toBe('Fiscal Year');
    });

    it('does not rename the data column', () => {
        syncBandColumnLabels(bandRows(['FY2025']));
        const plan = { title: 'Value by SeriesLabelL1', description: '', groupByColumn: 'SeriesLabelL1', valueColumn: 'Value' };
        resolveDisplayPlanTitle(plan);
        expect(plan.groupByColumn).toBe('SeriesLabelL1');
    });
});

describe('the report title is the most title-like preamble line', () => {
    it('picks the report name of w1, not the period', async () => {
        const { rawCsvData } = await loadFixture('w1_erp_outstanding.csv');
        const context = createFallbackReportContext(rawCsvData);
        expect(context.reportTitle).toBe('SALES ORDER OUTSTANDING REPORT');
        expect(context.reportTitle).not.toMatch(/From \d/);
        expect(context.parameterLines.join(' ')).toContain('From 01-01-2026 To 30-06-2026');
    });

    it('picks the "Report Name" value of w5, not "As At | 30-06-2026"', async () => {
        const { rawCsvData } = await loadFixture('w5_aging_meta_footnotes.csv');
        const context = createFallbackReportContext(rawCsvData);
        expect(context.reportTitle).toBe('AR Aging Analysis');
    });

    it('never offers a period, a key/value pair, dashes or a print stamp as a title', () => {
        ['From 01-01-2026 To 30-06-2026', 'As At | 30-06-2026', '--------------', 'Printed by: ADMIN  Page 1 of 80', 'w5_aging.csv']
            .forEach(line => {
                const data: CsvData = { fileName: 'f.csv', data: [{ A: 1 }], metadataRows: [[line]], headerLayers: [], summaryRows: [], headerDepth: 1 };
                expect(createFallbackReportContext(data).reportTitle, line).not.toBe(line);
            });
        expect(isUsableReportTitle('From 01-01-2026 To 30-06-2026')).toBe(false);
        expect(isUsableReportTitle('As At | 30-06-2026')).toBe(false);
        expect(isUsableReportTitle('AR Aging Analysis')).toBe(true);
    });

    it('replaces an AI title that is a period with the one read from the preamble', async () => {
        const { rawCsvData } = await loadFixture('w1_erp_outstanding.csv');
        const { effective } = verifyAiExtractedReportContext({
            reportTitle: 'From 01-01-2026 To 30-06-2026',
            reportDescription: '',
            parameterLines: ['From 01-01-2026 To 30-06-2026'],
            footerLines: [],
            candidateHeaderLine: null,
            confidence: 'high',
            reasoning: '',
        }, rawCsvData);
        expect(effective.reportTitle).toBe('SALES ORDER OUTSTANDING REPORT');
    });
});

describe('counts and numbers in scope text', () => {
    it('shows the group count with a thousands separator', () => {
        render(<AnalysisCardSummary
            cardId="big-ranking"
            plan={{ aggregation: 'sum', groupByColumn: 'Customer', valueColumn: 'Amount', title: 't', description: 'd' } as never}
            totalValue={100}
            overallTotalValue={5000}
            displayedRowCount={8}
            totalRowCount={8}
            totalGroupCount={2040}
            groupsComplete={false}
            displayedMetricLabel="Amount"
            displayedGroupLabel="Customer"
            topN={8}
            hideOthers={false}
            hiddenLabelCount={0}
            language="English"
        />);
        expect(screen.getByText('Top 8 of 2,040 groups')).toBeInTheDocument();
        expect(screen.queryByText(/2040/)).not.toBeInTheDocument();
    });

    it('formats counts and picks a/an by how the number is read', () => {
        expect(formatCount(3200)).toBe('3,200');
        expect(formatCount('2040')).toBe('2,040');
        expect(articleForNumber(826)).toBe('an');
        expect(articleForNumber(140)).toBe('a');
        expect(articleForNumber('18,000')).toBe('an');
        expect(articleForNumber(11)).toBe('an');
        expect(articleForNumber(110)).toBe('a');
        expect(fixNumberArticles('creating a 826 spread across the displayed rows')).toBe('creating an 826 spread across the displayed rows');
        expect(fixNumberArticles('an 17 point gap and A 80% drop')).toBe('a 17 point gap and An 80% drop');
    });

    it('rounds the rows a summary is written from to the precision the card shows', () => {
        expect(roundRowsToDisplayPrecision([{ Name: 'a', Median: 832.805, Count: 4, Big: 3020.8349 }]))
            .toEqual([{ Name: 'a', Median: 832.81, Count: 4, Big: 3020.83 }]);
    });

    it('hands the narrative the rounded sample, not 832.805', () => {
        const card = {
            id: 'c1',
            plan: { title: 'Median Amount by Customer', description: '', chartType: 'bar', aggregation: 'median', groupByColumn: 'Customer', valueColumn: 'Amount' },
            aggregatedData: [{ Customer: 'A', Amount: 832.805 }, { Customer: 'B', Amount: 3020.835 }],
            summary: { language: 'English', text: 's' },
        } as unknown as AnalysisCardData;
        const [input] = buildNarrativeAnalysisIrInputList([card]);
        expect(JSON.stringify(input.aggregatedDataSample)).not.toMatch(/\d\.\d{3}/);
    });
});

describe('a recommended action stays under its own finding', () => {
    it('renders each action inside the numbered finding it belongs to, in order', () => {
        const markdown = [
            '### Key Findings',
            '',
            '1. **Cables lead** — Cables is at 10,345. Confidence: high',
            '   → Recommended Action: Pull the Cables records.',
            '',
            '2. **Motors trail** — Motors is at 9,519. Confidence: high',
            '   → Recommended Action: Compare Motors with Cables.',
            '',
            '### Data Confidence Assessment',
            '',
            'Confidence is high.',
        ].join('\n');
        const { container } = render(<MarkdownRenderer content={markdown} />);
        const lists = container.querySelectorAll('ol');
        expect(lists).toHaveLength(1);
        const items = [...container.querySelectorAll('ol > li')];
        expect(items).toHaveLength(2);
        expect(items[0].textContent).toContain('Cables lead');
        expect(items[0].textContent).toContain('Pull the Cables records.');
        expect(items[1].textContent).toContain('Motors trail');
        expect(items[1].textContent).toContain('Compare Motors with Cables.');
        const text = container.textContent ?? '';
        expect(text.indexOf('Cables lead')).toBeLessThan(text.indexOf('Pull the Cables records.'));
        expect(text.indexOf('Pull the Cables records.')).toBeLessThan(text.indexOf('Motors trail'));
    });
});
