import assert from 'node:assert/strict';
import test from 'node:test';
import { DeployVerifyMode } from '../config/deployConfig';
import { resolveDeployFlow } from '../commands/deployFlow';

const BOOLS = [false, true] as const;
const VERIFY_MODES: readonly DeployVerifyMode[] = ['none', 'size', 'md5'];

for (const incrementalEnabled of BOOLS) {
	for (const cleanupEnabled of BOOLS) {
		for (const atomicEnabled of BOOLS) {
			for (const verifyAfterUpload of VERIFY_MODES) {
				test(
					`deployFlow matrix (preview=false): incremental=${incrementalEnabled}, cleanup=${cleanupEnabled}, atomic=${atomicEnabled}, verify=${verifyAfterUpload}`,
					() => {
						const resolved = resolveDeployFlow({
							incrementalEnabled,
							cleanupEnabled,
							atomicEnabled,
							previewOnly: false,
							verifyAfterUpload
						});

						assert.equal(resolved.verifyAfterUpload, verifyAfterUpload);
						assert.equal(resolved.atomicEnabled, atomicEnabled);
						assert.equal(resolved.incrementalEnabled, atomicEnabled ? false : incrementalEnabled);
						assert.equal(resolved.cleanupEnabled, atomicEnabled ? false : cleanupEnabled);
						assert.equal(resolved.atomicDisabledIncremental, atomicEnabled && incrementalEnabled);
						assert.equal(resolved.atomicDisabledCleanup, atomicEnabled && cleanupEnabled);
					}
				);

				test(
					`deployFlow matrix (preview=true): incremental=${incrementalEnabled}, cleanup=${cleanupEnabled}, atomic=${atomicEnabled}, verify=${verifyAfterUpload}`,
					() => {
						const resolved = resolveDeployFlow({
							incrementalEnabled,
							cleanupEnabled,
							atomicEnabled,
							previewOnly: true,
							verifyAfterUpload
						});

						assert.equal(resolved.verifyAfterUpload, verifyAfterUpload);
						assert.equal(resolved.atomicEnabled, atomicEnabled);
						assert.equal(resolved.incrementalEnabled, incrementalEnabled);
						assert.equal(resolved.cleanupEnabled, cleanupEnabled);
						assert.equal(resolved.atomicDisabledIncremental, false);
						assert.equal(resolved.atomicDisabledCleanup, false);
					}
				);
			}
		}
	}
}
