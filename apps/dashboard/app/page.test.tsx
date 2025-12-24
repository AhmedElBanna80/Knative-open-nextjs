import { describe, it, expect } from 'vitest';

describe('Dashboard Page', () => {
  it('exports a valid page component', async () => {
    const module = await import('./page');
    expect(module.default).toBeDefined();
    expect(typeof module.default).toBe('function');
  });

  it('sets dynamic rendering correctly', async () => {
    const module = await import('./page');
    expect(module.dynamic).toBe('force-dynamic');
  });
});

