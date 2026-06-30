/**
 * Wave 0 test: Claude output parser (three shapes) + severity floor + fingerprint
 * Requirements: ENGN-06, POST-01, NOISE-01
 *
 * Tests parseClaudeOutput, validateFindings (via shape A), meetsMinSeverity,
 * and fingerprintFinding from src/provider/parser.ts.
 * All imports use .js extension per NodeNext ESM resolution.
 */

import { describe, it, expect } from 'vitest';
import {
  parseClaudeOutput,
  meetsMinSeverity,
  fingerprintFinding,
  FINDINGS_SCHEMA,
} from '../../src/provider/parser.js';

// Canonical Finding shape as expected from Plan 02's shared types (D-04)
interface Finding {
  file: string;
  line: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  title?: string;
  suggestion?: string;
}

const SAMPLE_FINDING: Finding = {
  file: 'src/auth.ts',
  line: 42,
  severity: 'high',
  message: 'Missing null check before access',
};

describe('parseClaudeOutput (ENGN-06)', () => {
  // Shape A: subtype === 'success' with structured_output
  describe('Shape A: JSON structured_output success', () => {
    it('parses valid structured_output into findings array', () => {
      const stdout = JSON.stringify({
        subtype: 'success',
        structured_output: {
          findings: [SAMPLE_FINDING],
          summary: 'One high-severity finding.',
        },
      });
      const result = parseClaudeOutput(stdout, '');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.file).toBe('src/auth.ts');
      expect(result.findings[0]!.severity).toBe('high');
      expect(result.summary).toBe('One high-severity finding.');
    });

    it('drops findings with invalid severity (POST-01)', () => {
      const stdout = JSON.stringify({
        subtype: 'success',
        structured_output: {
          findings: [
            { file: 'a.ts', line: 1, severity: 'invalid', message: 'bad' },
            { file: 'b.ts', line: 2, severity: 'high', message: 'good' },
          ],
          summary: 'Mixed severity',
        },
      });
      const result = parseClaudeOutput(stdout, '');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.severity).toBe('high');
    });

    it('drops findings where line < 1 (POST-01: GitHub requires line >= 1)', () => {
      const stdout = JSON.stringify({
        subtype: 'success',
        structured_output: {
          findings: [
            { file: 'a.ts', line: 0, severity: 'medium', message: 'line zero' },
            { file: 'a.ts', line: -1, severity: 'high', message: 'negative line' },
            { file: 'b.ts', line: 5, severity: 'low', message: 'valid' },
          ],
          summary: 'Lines test',
        },
      });
      const result = parseClaudeOutput(stdout, '');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.line).toBe(5);
    });

    it('returns empty findings array (not throws) on empty findings list', () => {
      const stdout = JSON.stringify({
        subtype: 'success',
        structured_output: { findings: [], summary: 'Clean PR.' },
      });
      const result = parseClaudeOutput(stdout, '');
      expect(result.findings).toHaveLength(0);
      expect(result.summary).toBe('Clean PR.');
    });
  });

  // Shape B: subtype === 'error_max_structured_output_retries'
  describe('Shape B: max-retries fallback to result text', () => {
    it('falls back to regex parsing of result text', () => {
      const stdout = JSON.stringify({
        subtype: 'error_max_structured_output_retries',
        result: 'src/x.ts:10: [high] Missing error handler\nSummary: Two issues found.',
      });
      const result = parseClaudeOutput(stdout, '');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.file).toBe('src/x.ts');
      expect(result.findings[0]!.line).toBe(10);
      expect(result.findings[0]!.severity).toBe('high');
    });

    it('handles empty result field gracefully', () => {
      const stdout = JSON.stringify({
        subtype: 'error_max_structured_output_retries',
        result: '',
      });
      expect(() => parseClaudeOutput(stdout, '')).not.toThrow();
    });
  });

  // Shape C: non-JSON garbled stdout
  describe('Shape C: garbled / non-JSON fallback', () => {
    it('uses regex fallback on non-JSON stdout', () => {
      const stdout = 'src/api.ts:25: [critical] SQL injection risk\nOther text.';
      const result = parseClaudeOutput(stdout, '');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.severity).toBe('critical');
      expect(result.findings[0]!.line).toBe(25);
    });

    it('returns empty findings (not throws) on completely garbled input', () => {
      expect(() => parseClaudeOutput('not json at all', 'err')).not.toThrow();
      const result = parseClaudeOutput('%%% gibberish %%%', '');
      expect(Array.isArray(result.findings)).toBe(true);
    });

    it('never throws on any input (SC4 robustness)', () => {
      expect(() => parseClaudeOutput('', '')).not.toThrow();
      expect(() => parseClaudeOutput('{broken json', 'stderr')).not.toThrow();
      expect(() => parseClaudeOutput('null', '')).not.toThrow();
    });
  });
});

describe('meetsMinSeverity (NOISE-01)', () => {
  it('returns false when finding severity is below the floor', () => {
    expect(meetsMinSeverity('low', 'medium')).toBe(false);
    expect(meetsMinSeverity('low', 'high')).toBe(false);
    expect(meetsMinSeverity('medium', 'high')).toBe(false);
  });

  it('returns true when finding severity meets the floor', () => {
    expect(meetsMinSeverity('high', 'medium')).toBe(true);
    expect(meetsMinSeverity('critical', 'medium')).toBe(true);
    expect(meetsMinSeverity('medium', 'medium')).toBe(true);
    expect(meetsMinSeverity('low', 'low')).toBe(true);
  });

  it('returns true when floor is low (everything passes)', () => {
    expect(meetsMinSeverity('low', 'low')).toBe(true);
    expect(meetsMinSeverity('medium', 'low')).toBe(true);
    expect(meetsMinSeverity('high', 'low')).toBe(true);
    expect(meetsMinSeverity('critical', 'low')).toBe(true);
  });
});

describe('fingerprintFinding (NOISE-01 dedup)', () => {
  it('produces the same fingerprint for the same file + message', () => {
    const f1 = { ...SAMPLE_FINDING };
    const f2 = { ...SAMPLE_FINDING };
    expect(fingerprintFinding(f1)).toBe(fingerprintFinding(f2));
  });

  it('produces the same fingerprint regardless of message whitespace differences', () => {
    const f1 = { ...SAMPLE_FINDING, message: 'Missing  null  check' };
    const f2 = { ...SAMPLE_FINDING, message: 'missing null check' };
    expect(fingerprintFinding(f1)).toBe(fingerprintFinding(f2));
  });

  it('produces different fingerprints for different files', () => {
    const f1 = { ...SAMPLE_FINDING, file: 'a.ts' };
    const f2 = { ...SAMPLE_FINDING, file: 'b.ts' };
    expect(fingerprintFinding(f1)).not.toBe(fingerprintFinding(f2));
  });

  it('fingerprint does not depend on line number (drift-tolerant)', () => {
    const f1 = { ...SAMPLE_FINDING, line: 10 };
    const f2 = { ...SAMPLE_FINDING, line: 20 };
    expect(fingerprintFinding(f1)).toBe(fingerprintFinding(f2));
  });

  it('fingerprint does not depend on severity', () => {
    const f1 = { ...SAMPLE_FINDING, severity: 'low' as const };
    const f2 = { ...SAMPLE_FINDING, severity: 'critical' as const };
    expect(fingerprintFinding(f1)).toBe(fingerprintFinding(f2));
  });
});

describe('FINDINGS_SCHEMA', () => {
  it('is a valid JSON string with the expected structure', () => {
    expect(() => JSON.parse(FINDINGS_SCHEMA)).not.toThrow();
    const schema = JSON.parse(FINDINGS_SCHEMA) as { properties: { findings: unknown } };
    expect(schema.properties.findings).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 401 degradation contract (T-jr6-01) -- documents why exitCode is authoritative
// ---------------------------------------------------------------------------

describe('parseClaudeOutput: 401 degradation and empty-stdout contracts (T-jr6-01)', () => {
  it('does not throw on 401-shaped result (is_error:true, no structured_output) and returns empty findings', () => {
    // This is the exact shape claude -p produces on a 401 auth failure:
    // subtype 'success' with is_error:true, api_error_status:401, and EMPTY structured_output.
    // The parser correctly returns findings:[] here -- which is exactly why pipeline.ts MUST
    // gate on exitCode (assertProviderSucceeded) and NOT on parsed output to detect failures.
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      result: 'Failed to authenticate. API Error: 401 Invalid bearer token',
    });
    expect(() => parseClaudeOutput(stdout, '')).not.toThrow();
    const result = parseClaudeOutput(stdout, '');
    // The parser sees no structured_output and falls through to the text fallback.
    // The text fallback finds no finding-shaped lines, so findings is empty.
    // This empty result is exactly why the pipeline must gate on exitCode, not on parsed output.
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('does not throw on completely empty stdout and returns empty findings', () => {
    // claude -p with exit 1 and empty stdout (e.g. process killed before output).
    expect(() => parseClaudeOutput('', '')).not.toThrow();
    const result = parseClaudeOutput('', '');
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.findings).toHaveLength(0);
  });
});
