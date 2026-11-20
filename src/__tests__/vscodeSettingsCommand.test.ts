/**
 * What VS Code shows for the daemon (U11): `EVƎ: Settings`, the daemon's questions, and a
 * disconnect while others hold the brick. The flows are free of `vscode`; these tests drive them
 * with a fake picker, dialog and notification.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContractBrick, Question, SettingValue } from '../contract/models';
import { FOR_EVERYONE_ACTION, disconnectBrick } from '../vscode/ui/disconnect';
import { LEND_ACTION, RELEASE_ACTION, answerQuestion } from '../vscode/ui/questions';
import { FULL_ACTION, SettingsUi, editSettings, settingRows } from '../vscode/ui/settings';

const accessMode: SettingValue = {
	spec: { key: 'accessMode', type: 'string', default: 'safe', enum: ['safe', 'full'], description: 'What may be written on the brick.', dangerous: true },
	value: 'safe',
};
const interval: SettingValue = {
	spec: { key: 'programs.statusIntervalMs', type: 'number', default: 1000, minimum: 100, maximum: 60000, description: 'How often a running program is checked.', dangerous: false },
	value: 1000,
};

function settingsWorld(answers: { picks: string[]; typed?: string; confirm?: boolean }) {
	const sent: unknown[] = [];
	const confirms: string[] = [];
	const ui: SettingsUi = {
		pick: (items) => { const wanted = answers.picks.shift(); return Promise.resolve(items.find((i) => i.label === wanted)); },
		input: (options) => Promise.resolve(answers.typed !== undefined && options.validate(answers.typed) === undefined ? answers.typed : undefined),
		confirm: (message) => { confirms.push(message); return Promise.resolve(answers.confirm === true); },
		showInfo: () => undefined,
		showError: () => undefined,
	};
	const client = {
		settings: () => [accessMode, interval],
		request: (_method: 'settings/set', params: unknown) => { sent.push(params); return Promise.resolve(accessMode); },
	};
	return { ui, client, sent, confirms };
}

describe('EVƎ: Settings', () => {
	it('lists every setting with its value', () => {
		const rows = settingRows([interval, accessMode]);
		assert.deepEqual(rows.map((r) => [r.label, r.description]), [['accessMode', 'safe'], ['programs.statusIntervalMs', '1000']]);
	});

	it('asks before switching to full, and declining leaves safe', async () => {
		const w = settingsWorld({ picks: ['accessMode', 'full'], confirm: false });
		await editSettings(w.client, w.ui);
		assert.equal(w.confirms.length, 1);
		assert.match(w.confirms[0], /full/);
		assert.deepEqual(w.sent, []);
	});

	it('switches to full with the person\'s confirmation', async () => {
		const w = settingsWorld({ picks: ['accessMode', 'full'], confirm: true });
		await editSettings(w.client, w.ui);
		assert.deepEqual(w.sent, [{ key: 'accessMode', value: 'full', confirmedByPerson: true }]);
		assert.equal(FULL_ACTION, 'Allow');
	});

	it('changes a number in range without asking, and refuses one out of range', async () => {
		const ok = settingsWorld({ picks: ['programs.statusIntervalMs'], typed: '500' });
		await editSettings(ok.client, ok.ui);
		assert.deepEqual(ok.sent, [{ key: 'programs.statusIntervalMs', value: 500 }]);
		assert.equal(ok.confirms.length, 0);
		const out = settingsWorld({ picks: ['programs.statusIntervalMs'], typed: '5' });
		await editSettings(out.client, out.ui);
		assert.deepEqual(out.sent, []);
	});
});

describe('the daemon\'s questions in VS Code', () => {
	const question = (kind: Question['kind'], text: string): Question => ({ questionId: 'q', kind, text, timeoutMs: 1000, brickId: 'CCC' });

	it('answers keep for a cut transfer\'s slot when the notification is dismissed, yes on Release', async () => {
		assert.equal(await answerQuestion(question('sweep', 'Release it now?'), { notify: () => Promise.resolve(undefined), modal: () => Promise.resolve(undefined) }), 'keep');
		assert.equal(await answerQuestion(question('sweep', 'Release it now?'), { notify: () => Promise.resolve(RELEASE_ACTION), modal: () => Promise.resolve(undefined) }), 'yes');
	});

	it('shows which brick a development daemon wants and who asks; anything but Lend keeps it', async () => {
		const shown: string[] = [];
		const text = 'A development cockpit (development daemon (dev, pid 7)) asks to borrow CCC. Lend it?';
		const ui = (choice: string | undefined) => ({
			notify: () => Promise.resolve(undefined),
			modal: (message: string) => { shown.push(message); return Promise.resolve(choice); },
		});
		assert.equal(await answerQuestion(question('brickLoan', text), ui(undefined)), 'no');
		assert.match(shown[0], /CCC/);
		assert.match(shown[0], /development daemon/);
		assert.equal(await answerQuestion(question('brickLoan', text), ui(LEND_ACTION)), 'yes');
	});
});

describe('disconnecting a brick others hold', () => {
	const ccc: ContractBrick = {
		brickId: 'CCC', name: 'CCC', nameConfirmed: true, connected: true, paired: true,
		channels: [{ transport: 'usb', state: 'connected' }], holders: [],
	};

	it('says who still holds it and disconnects it for everyone on request', async () => {
		const sent: unknown[] = [];
		const told: string[] = [];
		const client = {
			bricks: () => [ccc],
			request: (_m: 'bricks/disconnect', params: { forEveryone?: boolean }) => {
				sent.push(params);
				return Promise.resolve({ stillHeldBy: params.forEveryone ? [] : ['VS Code (other window)'] });
			},
		};
		await disconnectBrick(client, {
			pick: (items) => Promise.resolve(items[0]),
			notify: (message, ...actions) => { told.push(message); return Promise.resolve(actions[0]); },
			log: () => undefined,
		}, () => '');
		assert.match(told[0], /VS Code \(other window\)/);
		assert.deepEqual(sent, [{ brick: 'CCC' }, { brick: 'CCC', forEveryone: true }]);
		assert.equal(FOR_EVERYONE_ACTION, 'Disconnect for everyone');
	});
});
