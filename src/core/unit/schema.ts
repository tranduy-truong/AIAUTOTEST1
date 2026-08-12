export type UnitTestFramework = 'vitest' | 'jest' | 'unknown';
export type UnitLanguage = 'typescript' | 'javascript' | 'mixed' | 'unknown';
export type UnitTargetKind = 'function' | 'class' | 'class-method';
export type UnitExecutionMode =
  | 'NATIVE_DIRECT'
  | 'NATIVE_WITH_MOCKS'
  | 'NATIVE_REQUIRED'
  | 'UNSUPPORTED';

export type UnitTestabilityProfile =
  | 'UNIT_NATIVE'
  | 'UNIT_MOCKED'
  | 'COMPONENT_DOM'
  | 'INTEGRATION_SANDBOX'
  | 'PROCESS_SANDBOX'
  | 'ENTRYPOINT_SMOKE'
  | 'NO_RUNTIME_TEST'
  | 'REFACTOR_REQUIRED';

export type UnitRuntimeEnvironment = 'node' | 'jsdom' | 'browser' | 'integration' | 'none';

export interface UnitProjectManifest {
  version: 1;
  projectName: string;
  projectRoot: string;
  packageType: 'module' | 'commonjs' | 'unknown';
  language: UnitLanguage;
  testFramework: UnitTestFramework;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'unknown';
  sourceFiles: string[];
  configFiles: string[];
  scannedAt: string;
}

export interface UnitDependency {
  module: string;
  importedNames: string[];
  importBindings?: Array<{
    kind: 'default' | 'named' | 'namespace';
    localName: string;
    importedName: string;
  }>;
  external: boolean;
  boundary:
    | 'database'
    | 'network'
    | 'filesystem'
    | 'process'
    | 'time-random'
    | 'framework'
    | 'internal';
  strategy: 'real' | 'mock' | 'native-environment';
  mockKind?: 'module' | 'global';
  globalName?: string;
  resolvedFile?: string;
  /** Member/function names actually referenced by the selected target. */
  usedMembers?: string[];
}

export interface UnitBranch {
  id: string;
  kind: 'if' | 'switch' | 'ternary' | 'catch' | 'loop';
  condition: string;
  outcome: string;
  line: number;
}

export interface UnitParameter {
  name: string;
  type: string;
  optional: boolean;
}

export interface UnitClassMethodContext {
  className: string;
  methodName: string;
  static: boolean;
  constructorParameters: UnitParameter[];
  constructorCode?: string;
}

export interface UnitSupportingDefinition {
  sourceFile: string;
  sourceHash: string;
  symbol: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'constant';
  code: string;
}

export interface UnitCallGraphEdge {
  caller: string;
  callee: string;
  sourceFile: string;
  resolution: 'same-file' | 'internal-import';
}

export interface UnitReachableImport {
  sourceFile: string;
  module: string;
  importedNames: string[];
  resolvedFile?: string;
}

export interface UnitSupportingContext {
  callGraph: UnitCallGraphEdge[];
  helperDefinitions: UnitSupportingDefinition[];
  typeDefinitions: UnitSupportingDefinition[];
  constantDefinitions: UnitSupportingDefinition[];
  reachableImports: UnitReachableImport[];
  unresolvedSymbols: string[];
  truncated: boolean;
}

export interface UnitTarget {
  id: string;
  sourceFile: string;
  sourceHash: string;
  symbol: string;
  kind: UnitTargetKind;
  exported: boolean;
  defaultExport: boolean;
  async: boolean;
  parameters: UnitParameter[];
  returnType: string;
  classMethod?: UnitClassMethodContext;
  startLine: number;
  endLine: number;
  rawCode: string;
  dependencies: UnitDependency[];
  supportingContext: UnitSupportingContext;
  branches: UnitBranch[];
  executionMode: UnitExecutionMode;
  profile: UnitTestabilityProfile;
  runtimeEnvironment: UnitRuntimeEnvironment;
  profileReasons: string[];
  unsupportedReasons: string[];
}

export interface UnitTestabilityEntry {
  id: string;
  sourceFile: string;
  symbol?: string;
  profile: UnitTestabilityProfile;
  runtimeEnvironment: UnitRuntimeEnvironment;
  selected: boolean;
  generatable: boolean;
  reasons: string[];
}

export interface UnitTestabilityManifest {
  version: 1;
  projectRoot: string;
  generatedAt: string;
  entries: UnitTestabilityEntry[];
  summary: Record<UnitTestabilityProfile, number>;
}

export type UnitGenerationStatus =
  | 'GENERATED'
  | 'PARTIAL'
  | 'NO_RUNTIME'
  | 'REFACTOR_REQUIRED'
  | 'PROFILE_NOT_SUPPORTED'
  | 'STALE_SOURCE'
  | 'NEEDS_ORACLE'
  | 'AI_GENERATION_FAILED'
  | 'STATIC_VALIDATION_FAILED'
  | 'TYPECHECK_FAILED';

export type UnitTestCaseGenerationStatus =
  | 'GENERATED'
  | 'NEEDS_ORACLE'
  | 'INVALID_FIXTURE'
  | 'INVALID_MOCK';

export interface UnitTestCaseGenerationResult {
  testCaseId: string;
  status: UnitTestCaseGenerationStatus;
  errors: string[];
}

export interface UnitGenerationTargetResult {
  target: string;
  profile: UnitTestabilityProfile;
  status: UnitGenerationStatus;
  file?: string;
  errors: string[];
  testCases?: UnitTestCaseGenerationResult[];
}

export interface UnitCodeIndex {
  version: 1;
  projectRoot: string;
  targets: UnitTarget[];
  skippedFiles: Array<{ file: string; reason: string }>;
}

export interface UnitContextBundle {
  version: 1;
  project: UnitProjectManifest;
  targets: UnitTarget[];
  requirements?: string;
}

export type UnitOracleSource =
  | 'requirement'
  | 'type-contract'
  | 'existing-test'
  | 'implementation'
  | 'tester-confirmation';

export type UnitOracleEvidenceStatus = 'verified' | 'proposed' | 'observed';

export type UnitOracleEvidenceSource =
  | 'requirement'
  | 'existing-test'
  | 'return-literal'
  | 'throw-literal'
  | 'pure-evaluation'
  | 'mock-trace'
  | 'sandbox-observation'
  | 'ai-inference'
  | 'tester-confirmation';

/**
 * Machine-checkable provenance for an expected result. A Planner proposal is
 * deliberately not equivalent to verified evidence.
 */
export interface UnitOracleEvidence {
  status: UnitOracleEvidenceStatus;
  source: UnitOracleEvidenceSource;
  /** Exact excerpt/reference that must be present in tester requirements. */
  reference?: string;
  sourceFile?: string;
  line?: number;
  expression?: string;
  testFile?: string;
  testCaseId?: string;
}

export type UnitDataValue =
  | null
  | boolean
  | number
  | string
  | UnitDataValue[]
  | { [key: string]: UnitDataValue }
  | {
      $type: 'undefined' | 'nan' | 'infinity' | 'negative-infinity' | 'bigint' | 'date' | 'regexp';
      value?: string;
    }
  | {
      $type: 'map';
      entries: [UnitDataValue, UnitDataValue][];
    }
  | {
      $type: 'set';
      values: UnitDataValue[];
    };

export interface UnitExpectedResult {
  kind: 'return' | 'throw' | 'resolve' | 'reject' | 'side-effect';
  value?: UnitDataValue;
  /** @deprecated Use error.message for throw/reject. Kept for old plans. */
  message?: string;
  error?: {
    className?: 'Error' | 'TypeError' | 'RangeError' | 'SyntaxError' | 'ReferenceError';
    message?: {
      match: 'equals' | 'contains' | 'regexp';
      value: string;
      flags?: string;
    };
  };
  calls?: Array<{
    dependency: string;
    method?: string;
    arguments?: UnitDataValue[];
    times?: number;
  }>;
}

export type UnitMockOutcomeKind = 'return' | 'resolve' | 'reject' | 'throw';

export interface UnitMockOutcome {
  kind: UnitMockOutcomeKind;
  value?: UnitDataValue;
  message?: string;
  properties?: Record<string, UnitDataValue>;
  methods?: Record<string, UnitMockOutcome>;
}

export interface UnitMockBehavior extends UnitMockOutcome {
  /** Consecutive calls consume these outcomes in order. */
  sequence?: UnitMockOutcome[];
}

export interface UnitMockPlan {
  module: string;
  symbol?: string;
  behavior: UnitMockBehavior;
}

import type { ComprehensiveOracle, OracleGateResult } from './oracle/oracle-taxonomy.js';

export interface UnitPlannedTestCase {
  id: string;
  name: string;
  branchIds: string[];
  inputs: Record<string, UnitDataValue>;
  constructorInputs?: Record<string, UnitDataValue>;
  expected: UnitExpectedResult;
  /** @deprecated Kept for v1 migration compatibility. Use oracle.authority instead. */
  oracleSource?: UnitOracleSource;
  /** @deprecated Kept for v1 migration compatibility. Use oracle.evidence instead. */
  oracleEvidence?: UnitOracleEvidence;
  /** Taxonomy v2 3-Dimension Oracle */
  oracle?: ComprehensiveOracle;
  /** Oracle Gate result status */
  gate?: OracleGateResult;
  mocks: UnitMockPlan[];
  notes?: string[];
}

export interface UnitPlanTarget {
  sourceFile: string;
  symbol: string;
  sourceHash: string;
  executionMode: UnitExecutionMode;
  profile: UnitTestabilityProfile;
  testCases: UnitPlannedTestCase[];
}

export interface StructuredUnitPlan {
  version: 1 | 2;
  source: 'ai-planner' | 'deterministic-planner' | 'hybrid-planner';
  project: {
    name: string;
    root: string;
    testFramework: UnitTestFramework;
  };
  targets: UnitPlanTarget[];
  clarifications: string[];
}

export interface UnitSession {
  version: 1;
  runId: string;
  createdAt: string;
  projectRoot: string;
  projectName: string;
  testFramework: UnitTestFramework;
  runDirectory: string;
  contextPath: string;
  planPath: string;
  generatedFiles: string[];
  generatedTargetFiles?: Record<string, string>;
  coverageIteration?: number;
}
