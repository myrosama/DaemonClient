import { describe, expect, it } from 'vitest';
import { safeContinue } from './safe-continue';

describe('safeContinue', () => {
  it('keeps a path inside the app', () => {
    expect(safeContinue('/photos', '/x')).toBe('/photos');
    expect(safeContinue('/albums/abc?with=query#frag', '/x')).toBe('/albums/abc?with=query#frag');
    expect(safeContinue('  /photos ', '/x')).toBe('/photos');
  });

  it('refuses every way off the site', () => {
    for (const raw of ['https://evil.example', '//evil.example', '/\\evil.example', '\\\\evil.example', '/\t/evil.example',
      '/\n/evil.example', 'javascript:alert(1)', 'photos', '', '   ', null, undefined]) {
      expect(safeContinue(raw, '/fallback')).toBe('/fallback');
    }
  });
});
