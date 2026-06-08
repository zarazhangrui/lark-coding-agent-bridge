import { describe, expect, it } from 'vitest';
import { loadDefaultFleetManifest, summarizeFleetManifest } from '../../../src/fleet/manifest';

describe('FusionBridge fleet manifest', () => {
  it('loads the canonical eight assistants with unique ids', async () => {
    const manifest = await loadDefaultFleetManifest();

    expect(manifest.assistants).toHaveLength(8);
    expect(new Set(manifest.assistants.map((assistant) => assistant.id)).size).toBe(8);
    expect(new Set(manifest.assistants.map((assistant) => assistant.appId)).size).toBe(8);
    expect(summarizeFleetManifest(manifest).machines).toEqual({
      mac1: { claude: 1, codex: 1 },
      mac2: { claude: 1, codex: 1 },
      win3: { claude: 1, codex: 1 },
      win4: { claude: 1, codex: 1 },
    });
  });
});
