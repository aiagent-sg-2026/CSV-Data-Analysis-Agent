// Public acceptance policy. Operator reports are evidence, not runtime dependencies or authorization.
const thresholds = {
  solvableCorrect: 108, solvableRuns: 120, familyMinimumCorrect: 12, familyRuns: 15,
  ambiguityCorrect: 29, ambiguityRuns: 30, adversarialRuns: 30, maximumCriticalFailures: 0,
  admittedEvidenceCoverage: 1, deterministicAcceptanceCoverage: 1,
  minimumNovelRepairCases: 16, minimumNewMethodCases: 1,
};
export const QUALIFICATION_THRESHOLDS = Object.freeze(thresholds);
