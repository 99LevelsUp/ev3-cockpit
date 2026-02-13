import { test, expect, _electron as electron, type ElectronApplication, type Page, type Frame } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
const EXTENSION_DEV_PATH = path.resolve(__dirname, '..');

async function createWorkspace(settings: Record<string, unknown>): Promise<string> {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ev3-cockpit-workspace-'));
	const vscodeDir = path.join(workspaceRoot, '.vscode');
	await fs.mkdir(vscodeDir, { recursive: true });
	await fs.writeFile(path.join(vscodeDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
	return workspaceRoot;
}

async function updateWorkspaceSettings(workspaceRoot: string, updates: Record<string, unknown>): Promise<void> {
	const settingsPath = path.join(workspaceRoot, '.vscode', 'settings.json');
	let current: Record<string, unknown> = {};
	try {
		const raw = await fs.readFile(settingsPath, 'utf8');
		current = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		current = {};
	}
	for (const [key, value] of Object.entries(updates)) {
		current[key] = value;
	}
	await fs.mkdir(path.dirname(settingsPath), { recursive: true });
	await fs.writeFile(settingsPath, JSON.stringify(current, null, 2), 'utf8');
}

async function launchVsCode(workspacePath: string): Promise<{
	app: ElectronApplication;
	tempRoot: string;
	userDataDir: string;
	extensionsDir: string;
}> {
	const vscodeVersion = process.env.VSCODE_TEST_VERSION?.trim() || '1.109.0';
	const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ev3-cockpit-playwright-'));
	const userDataDir = path.join(tempRoot, 'user-data');
	const extensionsDir = path.join(tempRoot, 'extensions');
	await fs.mkdir(userDataDir, { recursive: true });
	await fs.mkdir(extensionsDir, { recursive: true });

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
			EXTENSION_DEV_PATH
		]
	});

	return { app, tempRoot, userDataDir, extensionsDir };
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

/** Polls page.frames() for the inner webview frame containing #root. */
async function waitForWebviewFrame(page: Page, timeoutMs: number): Promise<Frame | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const frame of page.frames()) {
			if (!frame.url().startsWith('vscode-webview://')) {
				continue;
			}
			// Extension webview content lives in a child iframe
			for (const child of frame.childFrames()) {
				try {
					if ((await child.locator('#root').count()) > 0) {
						return child;
					}
				} catch { /* frame not ready */ }
			}
			try {
				if ((await frame.locator('#root').count()) > 0) {
					return frame;
				}
			} catch { /* not ready */ }
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return null;
}

async function openEv3View(page: Page): Promise<void> {
	await runCommand(page, 'EV3 Cockpit: Open Brick Panel');
	const found = await waitForEv3Webview(page, 8000);
	if (!found) {
		await openViewPicker(page, 'EV3');
	}
	const paneHeader = page.locator('.pane .pane-header:has-text("EV3")').first();
	if ((await paneHeader.count()) > 0) {
		await paneHeader.click();
	}
}

test.describe('VS Code UI', () => {
	test('EV3 brick panel webview renders tabs @smoke', async () => {
		test.setTimeout(120000);
		if (test.info().project.name !== 'chromium') {
			test.skip(true, 'VS Code UI automation runs only on Chromium.');
		}

		const workspaceRoot = await createWorkspace({
			'ev3-cockpit.transport.timeoutMs': 200,
			'ev3-cockpit.transport.mode': 'usb',
			'ev3-cockpit.mock': false
		});
		const { app, tempRoot } = await launchVsCode(workspaceRoot);
		try {
			const page = await app.firstWindow();
			await page.waitForLoadState('domcontentloaded');

			// Wait for extension host to register commands
			await page.waitForTimeout(5000);

			await openEv3View(page);

			const webviewFrame = await waitForWebviewFrame(page, 20000);
			if (!webviewFrame) {
				throw new Error('EV3 webview did not open (no webview frame detected).');
			}
			await expect(webviewFrame.locator('#root')).toBeVisible({ timeout: 15000 });

			const tabCount = await webviewFrame.locator('.brick-tab').count();
			expect(tabCount).toBeGreaterThan(0);

			// Open discovery section via the "+" tab
			await webviewFrame.locator('.brick-tab.add-tab').click();
			await expect(webviewFrame.locator('.discovery-section')).toBeVisible({ timeout: 15000 });

			// Verify mock bricks appear/disappear based on settings
			const mockNames = ['Mock 1', 'Mock 1.1', 'Mock 1.1.1', 'Mock 2', 'Mock 2.1', 'Mock 2.2', 'Mock 3'];
			const exactLabel = (name: string) =>
				webviewFrame.locator('.discovery-main-label', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) });

			for (const name of mockNames) {
				await expect(exactLabel(name)).toHaveCount(0);
			}

			await updateWorkspaceSettings(workspaceRoot, { 'ev3-cockpit.mock': true });
			for (const name of mockNames) {
				await expect(exactLabel(name)).toHaveCount(1, { timeout: 15000 });
			}

			await updateWorkspaceSettings(workspaceRoot, { 'ev3-cockpit.mock': false });
			for (const name of mockNames) {
				await expect(exactLabel(name)).toHaveCount(0, { timeout: 15000 });
			}
		} finally {
			await app.close();
			await fs.rm(tempRoot, { recursive: true, force: true });
			await fs.rm(workspaceRoot, { recursive: true, force: true });
		}
	});
});
