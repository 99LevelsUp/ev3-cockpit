/**
 * What VS Code shows for the daemon: `EVƎ: Settings`, the daemon's questions, and a disconnect
 * while others hold the brick. The flows are free of `vscode`; these tests drive them with a fake
 * picker, dialog and notification.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContractBrick, Question, Requester, SettingScalar, SettingValue } from '../contract/generated';
import { FOR_EVERYONE_ACTION, disconnectBrick } from '../vscode/ui/disconnect';
import { RELEASE_ACTION, answerQuestion, rememberAction } from '../vscode/ui/questions';
import { FULL_ACTION, SettingsUi, editSettings, settingRows } from '../vscode/ui/settings';

const spec = { cliKey: '', stored: true } as const;
const accessMode: SettingValue = {
	spec: { ...spec, key: 'accessMode', cliKey: 'access-mode', type: 'string', default: 'safe', enum: ['safe', 'full'], description: 'What may be written on the brick.', dangerous: true, stored: false },
	value: 'safe',
};
const interval: SettingValue = {
	spec: { ...spec, key: 'programs.statusIntervalMs', type: 'integer', default: 1000, minimum: 100, maximum: 60000, description: 'How often a running program is checked.', dangerous: false },
	value: 1000,
};
const factor: SettingValue = {
	spec: { ...spec, key: 'telemetry.staleFactor', type: 'number', default: 3, exclusiveMinimum: 1, description: 'Intervals before a value is stale.', dangerous: false },
	value: 3,
};

function settingsWorld(answers: { picks: string[]; typed?: string; confirm?: boolean }) {
	const sent: { key: string; value: SettingScalar; confirmedHere: boolean }[] = [];
	const confirms: string[] = [];
	const ui: SettingsUi = {
		pick: (items) => { const wanted = answers.picks.shift(); return Promise.resolve(items.find((i) => i.label === wanted)); },
		input: (options) => Promise.resolve(answers.typed !== undefined && options.validate(answers.typed) === undefined ? answers.typed : undefined),
		confirm: (message) => { confirms.push(message); return Promise.resolve(answers.confirm === true); },
		showInfo: () => undefined,
		showError: () => undefined,
	};
	const client = {
		settings: () => [accessMode, interval, factor],
		set: (key: string, value: SettingScalar, confirmedHere: boolean) => { sent.push({ key, value, confirmedHere }); return Promise.resolve(accessMode); },
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

	it('switches to full with the person\'s confirmation, which the daemon\'s question is then answered from', async () => {
		const w = settingsWorld({ picks: ['accessMode', 'full'], confirm: true });
		await editSettings(w.client, w.ui);
		assert.deepEqual(w.sent, [{ key: 'accessMode', value: 'full', confirmedHere: true }]);
		assert.equal(FULL_ACTION, 'Allow');
	});

	it('changes a whole number in range without asking, and refuses one out of range or with a fraction', async () => {
		const ok = settingsWorld({ picks: ['programs.statusIntervalMs'], typed: '500' });
		await editSettings(ok.client, ok.ui);
		assert.deepEqual(ok.sent, [{ key: 'programs.statusIntervalMs', value: 500, confirmedHere: false }]);
		assert.equal(ok.confirms.length, 0);
		for (const typed of ['5', '500.5']) {
			const out = settingsWorld({ picks: ['programs.statusIntervalMs'], typed });
			await editSettings(out.client, out.ui);
			assert.deepEqual(out.sent, [], `${typed} was sent`);
		}
	});

	it('refuses a number at its exclusive minimum and takes one above it', async () => {
		const at = settingsWorld({ picks: ['telemetry.staleFactor'], typed: '1' });
		await editSettings(at.client, at.ui);
		assert.deepEqual(at.sent, []);
		const above = settingsWorld({ picks: ['telemetry.staleFactor'], typed: '1.5' });
		await editSettings(above.client, above.ui);
		assert.deepEqual(above.sent, [{ key: 'telemetry.staleFactor', value: 1.5, confirmedHere: false }]);
	});
});

describe('the daemon\'s questions in VS Code', () => {
	const me: Requester = { name: 'VS Code (test window)', kind: 'vscode' };
	const agent: Requester = { name: 'an agent', kind: 'mcp' };
	const ui = (choice: (actions: string[]) => string | undefined, shown: { message: string; actions: string[] }[] = []) => ({
		notify: (message: string, ...actions: string[]) => { shown.push({ message, actions }); return Promise.resolve(choice(actions)); },
		modal: (message: string, _detail: string, ...actions: string[]) => { shown.push({ message, actions }); return Promise.resolve(choice(actions)); },
	});
	const sweep = (requester: Requester): Question => ({ kind: 'sweep', questionId: 'q', text: 'Release it now?', timeoutMs: 1000, requester, brickId: 'CCC' });
	const full = (requester: Requester): Question => ({
		kind: 'setting', questionId: 'q', text: 'Switch the access mode to full?', timeoutMs: 1000, requester, key: 'accessMode', value: 'full',
	});

	it('answers keep for a cut transfer\'s slot when the notification is dismissed, yes on Release', async () => {
		assert.deepEqual(await answerQuestion(sweep(agent), ui(() => undefined), me), { answer: 'keep' });
		assert.deepEqual(await answerQuestion(sweep(agent), ui(() => RELEASE_ACTION), me), { answer: 'yes' });
	});

	it('names the MCP client whose request raised the question, and offers no remembered answer for it', async () => {
		const shown: { message: string; actions: string[] }[] = [];
		const reply = await answerQuestion(full(agent), ui(() => undefined, shown), me);
		assert.deepEqual(reply, { answer: 'no' });
		assert.match(shown[0].message, /^an agent \(an AI agent over MCP\) asks: Switch the access mode to full\?$/);
		assert.deepEqual(shown[0].actions, ['Allow']);
	});

	it('shows a question this window\'s own request raised without a requester, and can remember the answer', async () => {
		const shown: { message: string; actions: string[] }[] = [];
		const reply = await answerQuestion(full(me), ui((actions) => actions[1], shown), me);
		assert.equal(shown[0].message, 'Switch the access mode to full?');
		assert.deepEqual(shown[0].actions, ['Allow', rememberAction('Allow')]);
		assert.deepEqual(reply, { answer: 'yes', remember: true });
	});

	it('says no to a dialog that is dismissed, and asks Bluetooth access with the command it runs', async () => {
		const shown: string[] = [];
		const reply = await answerQuestion(
			{ kind: 'bluetoothAccess', questionId: 'q', text: 'Add you to the bluetooth group?', details: ['usermod -aG bluetooth user'], timeoutMs: 1000 },
			{ notify: () => Promise.resolve(undefined), modal: (message, detail) => { shown.push(message, detail); return Promise.resolve(undefined); } },
			me);
		assert.deepEqual(reply, { answer: 'no' });
		assert.deepEqual(shown, ['Add you to the bluetooth group?', 'It runs: usermod -aG bluetooth user']);
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
			activeBrick: () => undefined,
			setActiveBrick: () => Promise.resolve(),
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

	it('stops showing the brick it let go of, and keeps showing another', async () => {
		let active: string | undefined = 'CCC';
		const set: (string | undefined)[] = [];
		const client = (shows: string) => {
			active = shows;
			return {
				bricks: () => [ccc],
				request: () => Promise.resolve({ stillHeldBy: [] }),
				activeBrick: () => active,
				setActiveBrick: (id: string | undefined) => { set.push(id); active = id; return Promise.resolve(); },
			};
		};
		const ui = { pick: <T>(items: readonly T[]) => Promise.resolve(items[0]), notify: () => Promise.resolve(undefined), log: () => undefined };
		await disconnectBrick(client('CCC'), ui, () => '');
		assert.deepEqual(set, [undefined]);
		assert.equal(active, undefined);
		await disconnectBrick(client('BBB'), ui, () => '');
		assert.deepEqual(set, [undefined], 'a window showing another brick keeps showing it');
		assert.equal(active, 'BBB');
	});
});
