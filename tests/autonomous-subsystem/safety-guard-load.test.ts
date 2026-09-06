import { it, expect } from 'vitest';
import { SubsystemLoader } from '../../src/harness/autonomous-subsystem/loader.js';
import { join } from 'node:path';

it('loads safety-guard from subsystems/ directory', async () => {
  const loader = new SubsystemLoader({
    builtinDir: join(process.cwd(), 'src', 'subsystems'),
  });
  const result = await loader.loadAll();

  const safetyGuard = result.specs.find((s) => s.id === 'safety-guard');
  expect(safetyGuard).toBeDefined();
  expect(safetyGuard!.name).toBe('Safety Guard');
  expect(safetyGuard!.think.implementation).toBe('llm');
  expect(safetyGuard!.think.systemPrompt).toContain('安全守卫');
  expect(safetyGuard!.act.mode).toBe('block');
  expect(safetyGuard!.boundary.authority).toBe('act');
  expect(safetyGuard!.boundary.visibility).toBe('structured');
  expect(safetyGuard!.think.model).toBe('mini');
  expect(safetyGuard!.lifecycle?.maxDurationMs).toBe(15000);
});
