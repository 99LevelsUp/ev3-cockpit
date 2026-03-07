import { test, expect, _electron as electron, type ElectronApplication, type Page, type Frame } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { buildMockBricksFromConfig } from '../src/mock/mockCatalog';
import { acquireVsCodeLaunchLock } from './vscodeLaunchLock';
const EXTENSION_DEV_PATH = path.resolve(__dirname, '..');
const MOCK_CONFIG_PATH = path.resolve(EXTENSION_DEV_PATH, 'config', 'mock-bricks.json');

async function createWorkspace(settings: Record<string, unknown>): Promise<string> {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ev3-cockpit-workspace-'));
	const vscodeDir = path.join(workspaceRoot, '.vscode');
	await fs.mkdir(vscodeDir, { recursive: true });
	await fs.writeFile(path.join(vscodeDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
	return workspaceRoot;
}

async function readMockNamesFromConfig(): Promise<string[]> {
	const raw = await fs.readFile(MOCK_CONFIG_PATH, 'utf8');
	const parsed = JSON.parse(raw) as unknown;
	return buildMockBricksFromConfig(parsed).map((entry) => entry.displayName).sort();
}


async function launchVsCode(workspacePath: string): Promise<{
	app: ElectronApplication;
	tempRoot: string;
	userDataDir: string;
	extensionsDir: string;
}> {
	const releaseLaunchLock = await acquireVsCodeLaunchLock();
	const vscodeVersion = process.env.VSCODE_TEST_VERSION?.trim() || '1.109.0';
	const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ev3-cockpit-playwright-'));
	const userDataDir = path.join(tempRoot, 'user-data');
	const extensionsDir = path.join(tempRoot, 'extensions');
	await fs.mkdir(userDataDir, { recursive: true });
	await fs.mkdir(extensionsDir, { recursive: true });

	try {
		const linuxSandboxArgs = process.platform === 'linux'
			? ['--no-sandbox', '--disable-setuid-sandbox']
			: [];
		const app = await electron.launch({
			executablePath: vscodeExecutablePath,
			args: [
				workspacePath,
				'--disable-updates',
				'--skip-release-notes',
				'--skip-welcome',
				'--disable-workspace-trust',
				'--user-data-dir',
				userDataDir,
				'--extensions-dir',
				extensionsDir,
				'--extensionDevelopmentPath',
				EXTENSION_DEV_PATH,
				...linuxSandboxArgs
			]
		});
		return { app, tempRoot, userDataDir, extensionsDir };
	} finally {
		await releaseLaunchLock();
	}
}

async function openCommandPalette(page: Page): Promise<{ input: ReturnType<Page['locator']>; prefix: string }> {
	await page.waitForSelector('.monaco-workbench', { timeout: 15000 });
	await page.mouse.click(20, 20);
	const input = page.locator('.quick-input-widget input');
	await page.keyboard.press('F1');
	await input.waitFor({ state: 'visible', timeout: 10000 });
	const currentValue = await input.inputValue();
	const prefix = currentValue.trim().startsWith('>') ? '>' : '';
	return { input, prefix };
}

async function runCommand(page: Page, command: string): Promise<void> {
	const { input, prefix } = await openCommandPalette(page);
	const entries = page.locator('.quick-input-list .quick-input-list-entry');
	const tryFill = async (value: string): Promise<boolean> => {
		await input.fill(value);
		const entry = entries.filter({ hasText: command }).first();
		try {
			await entry.waitFor({ state: 'visible', timeout: 8000 });
			await entry.click();
			return true;
		} catch {
			return false;
		}
	};
	if (!await tryFill(`${prefix}${command}`)) {
		const fallbackPrefix = prefix ? '' : '>';
		if (!await tryFill(`${fallbackPrefix}${command}`)) {
			const texts = await entries.allTextContents();
			throw new Error(`Command "${command}" not found. Entries: ${JSON.stringify(texts.slice(0, 20))}`);
		}
	}
	const stillVisible = await input.isVisible().catch(() => false);
	if (stillVisible) {
		await page.keyboard.press('Escape');
	}
}

async function openViewPicker(page: Page, viewName: string): Promise<void> {
	const { input, prefix } = await openCommandPalette(page);
	await input.fill(`${prefix}View: Open View`);
	const entries = page.locator('.quick-input-list .quick-input-list-entry');
	const commandEntry = entries.filter({ hasText: 'View: Open View' }).first();
	await commandEntry.waitFor({ state: 'visible', timeout: 8000 });
	await commandEntry.click();
	await input.waitFor({ state: 'visible', timeout: 10000 });
	await input.fill(viewName);
	await entries.first().waitFor({ state: 'visible', timeout: 10000 });
	const preferred = entries.filter({ hasText: viewName }).filter({ hasText: 'Secondary Side Bar' }).first();
	if ((await preferred.count()) > 0) {
		await preferred.click();
	} else {
		await page.keyboard.press('Enter');
	}
	const stillVisible = await input.isVisible().catch(() => false);
	if (stillVisible) {
		await page.keyboard.press('Escape');
	}
}

async function waitForEv3Webview(page: Page, timeoutMs: number): Promise<boolean> {
	try {
		await page.waitForSelector('iframe.webview, webview.webview', { timeout: timeoutMs });
		return true;
	} catch {
		return false;
	}
}

function collectFramesRecursive(frame: Frame): Frame[] {
	const frames: Frame[] = [frame];
	for (const child of frame.childFrames()) {
		frames.push(...collectFramesRecursive(child));
	}
	return frames;
}

/** Polls all frames recursively for EV3 webview content. */
async function waitForWebviewFrame(page: Page, timeoutMs: number): Promise<Frame | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const rootFrames = page.frames();
		const allFrames: Frame[] = [];
		for (const root of rootFrames) {
			allFrames.push(...collectFramesRecursive(root));
		}
		for (const frame of allFrames) {
			try {
				const hasRoot = (await frame.locator('#root').count()) > 0;
				const hasTabs = (await frame.locator('.brick-tab').count()) > 0;
				if (hasRoot || hasTabs) {
					return frame;
				}
			} catch { /* not ready */ }
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return null;
}

async function openEv3View(page: Page): Promise<void> {
	try {
		await runCommand(page, 'EV3 Cockpit: Open Brick Panel');
	} catch {
		// Command may not be registered yet; fall back to view picker.
	}
	const found = await waitForEv3Webview(page, 8000);
	if (!found) {
		await openViewPicker(page, 'EV3');
	}
	const paneHeader = page.locator('.pane .pane-header:has-text("EV3")').first();
	if ((await paneHeader.count()) > 0) {
		await paneHeader.click();
	}
}

async function ensureEv3WebviewReady(page: Page, maxAttempts: number): Promise<Frame> {
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		await openEv3View(page);
		const webviewFrame = await waitForWebviewFrame(page, 30000);
		if (webviewFrame) {
			return webviewFrame;
		}
		await page.waitForTimeout(1500);
	}
	throw new Error('EV3 webview did not open (no webview frame detected).');
}

test.describe('VS Code UI', () => {
	test('EV3 brick panel webview renders tabs @smoke', async () => {
		test.setTimeout(300000);
		if (test.info().project.name !== 'chromium') {
			test.skip(true, 'VS Code UI automation runs only on Chromium.');
		}
		if (process.platform === 'linux') {
			test.skip(true, 'VS Code webview automation is flaky in Linux headless CI.');
		}

		const workspaceRoot = await createWorkspace({
			'ev3-cockpit.transport.timeoutMs': 200,
			'ev3-cockpit.transport.mode': 'usb',
			'ev3-cockpit.mock': false
		});
		const expectedMockNames = await readMockNamesFromConfig();
		const { app, tempRoot } = await launchVsCode(workspaceRoot);
		try {
			const page = await app.firstWindow();
			await page.waitForLoadState('domcontentloaded');

			// Wait for extension host to register commands
			await page.waitForTimeout(5000);

			const webviewFrame = await ensureEv3WebviewReady(page, 3);
			await expect(webviewFrame.locator('#root')).toBeVisible({ timeout: 15000 });

			await expect
				.poll(async () => webviewFrame.locator('.brick-tab').count(), { timeout: 15000 })
				.toBeGreaterThan(0);

			// Open discovery section via the "+" tab
			await webviewFrame.locator('.brick-tab.add-tab').waitFor({ state: 'visible', timeout: 15000 });
			await webviewFrame.locator('.brick-tab.add-tab').click();
			await expect(webviewFrame.locator('.discovery-section')).toBeVisible({ timeout: 15000 });

			// Verify mock bricks appear/disappear based on settings
			const listMockNames = async (): Promise<string[]> => {
				return webviewFrame.locator('.discovery-item').evaluateAll((nodes) => {
					const names: string[] = [];
					for (const node of nodes) {
						const transport = (node.getAttribute('data-transport') ?? '').toLowerCase();
						const candidateId = (node.getAttribute('data-candidate-id') ?? '').toLowerCase();
						const isMock = transport === 'mock' || candidateId.startsWith('mock-');
						if (!isMock) {
							continue;
						}
						const label = node.querySelector('.discovery-main-label')?.textContent?.trim() ?? '';
						if (label) {
							names.push(label);
						}
					}
					return names;
				});
			};
			const setMockVisibility = async (enabled: boolean): Promise<void> => {
				for (let attempt = 0; attempt < 3; attempt += 1) {
					await webviewFrame.locator('.brick-tab.add-tab').click();
					const current = (await listMockNames()).sort();
					const matchesTarget = enabled
						? JSON.stringify(current) === JSON.stringify(expectedMockNames)
						: current.length === 0;
					if (matchesTarget) {
						return;
					}
					await runCommand(page, 'EV3 Cockpit: Toggle Mock Bricks');
					await page.waitForTimeout(300);
				}

				if (enabled) {
					await expect.poll(async () => (await listMockNames()).sort(), { timeout: 30000 }).toEqual(expectedMockNames);
				} else {
					await expect.poll(listMockNames, { timeout: 30000 }).toEqual([]);
				}
			};

			await setMockVisibility(false);
			await setMockVisibility(true);
			await setMockVisibility(false);
		} finally {
			await app.close();
			await fs.rm(tempRoot, { recursive: true, force: true });
			await fs.rm(workspaceRoot, { recursive: true, force: true });
		}
	});
});
