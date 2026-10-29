// @vitest-environment node
import {it,expect} from 'vitest';
import {bridgeFixture} from './helpers/headerRepairBridgeFixture';
import {solveHeaderAlignment} from '../services/agent/headerAlignment';
import {parseCsvTextWithDetection} from '../services/data/csvDialectDetector';
import {buildReportIntakeIr} from '../services/data/reportCsvIntake';
it('has two independently valid full semantic alternatives and a genuinely ambiguous metric header',async()=>{const f=bridgeFixture();const p=parseCsvTextWithDetection(f.text);const a=await solveHeaderAlignment(buildReportIntakeIr('fictional.csv',p.rawRows,p.detection));expect(a.status).toBe('semantic_review_required');expect(a.candidates).toHaveLength(2);expect(f.proposal.interpretations[0].meaning.tables[0].projections[0][1].sourceColumn).not.toBe(f.proposal.interpretations[1].meaning.tables[0].projections[0][1].sourceColumn);});
