/**
 * How an event emitter delivers, observed scenario by scenario.
 *
 * The same scenarios run against VS Code's own `EventEmitter` in the extension host and against the
 * core's emitter in both the host and the unit suite, so the core delivers as VS Code does without
 * anyone having to assume what VS Code does. Each scenario returns what it saw; nothing here asserts.
 */

/** The part of an event emitter the scenarios use: VS Code's shape. */
export interface EmitterLike<T> {
	readonly event: (
		listener: (e: T) => unknown,
		thisArgs?: unknown,
		disposables?: { dispose(): unknown }[],
	) => { dispose(): unknown };
	fire(data: T): void;
	dispose(): void;
}

export type EmitterFactory = <T>() => EmitterLike<T>;

/** One scenario: a name and what it observed. */
export interface Observation {
	readonly scenario: string;
	readonly seen: unknown;
}

function scenario(name: string, run: (make: EmitterFactory) => unknown): (make: EmitterFactory) => Observation {
	return (make) => ({ scenario: name, seen: run(make) });
}

const SCENARIOS = [
	scenario('listeners are called in subscription order with the fired value', (make) => {
		const emitter = make<number>();
		const calls: string[] = [];
		emitter.event((n) => calls.push(`a${n}`));
		emitter.event((n) => calls.push(`b${n}`));
		emitter.event((n) => calls.push(`c${n}`));
		emitter.fire(1);
		emitter.fire(2);
		return calls;
	}),
	scenario('a disposed subscription is not called, the others are', (make) => {
		const emitter = make<number>();
		const calls: string[] = [];
		emitter.event(() => calls.push('a'));
		const b = emitter.event(() => calls.push('b'));
		emitter.event(() => calls.push('c'));
		b.dispose();
		emitter.fire(1);
		b.dispose();
		emitter.fire(2);
		return calls;
	}),
	scenario('a listener that throws does not stop the others, and fire does not throw', (make) => {
		const emitter = make<number>();
		const calls: string[] = [];
		emitter.event(() => calls.push('a'));
		emitter.event(() => { calls.push('b'); throw new Error('listener failed'); });
		emitter.event(() => calls.push('c'));
		let threw = false;
		try { emitter.fire(1); } catch { threw = true; }
		return { calls, threw };
	}),
	scenario('a listener added during a fire', (make) => {
		const emitter = make<number>();
		const calls: string[] = [];
		let added = false;
		emitter.event((n) => {
			calls.push(`a${n}`);
			if (!added) { added = true; emitter.event((m) => calls.push(`late${m}`)); }
		});
		emitter.event((n) => calls.push(`b${n}`));
		emitter.fire(1);
		emitter.fire(2);
		return calls;
	}),
	scenario('a listener removed during a fire before its turn', (make) => {
		const emitter = make<number>();
		const calls: string[] = [];
		// The first listener runs only at fire time, after `c` is assigned.
		emitter.event((n) => { calls.push(`a${n}`); c.dispose(); });
		emitter.event((n) => calls.push(`b${n}`));
		const c = emitter.event((n) => calls.push(`c${n}`));
		emitter.fire(1);
		emitter.fire(2);
		return calls;
	}),
	scenario('a listener that removes itself during a fire', (make) => {
		const emitter = make<number>();
		const calls: string[] = [];
		const a = emitter.event((n) => { calls.push(`a${n}`); a.dispose(); });
		emitter.event((n) => calls.push(`b${n}`));
		emitter.fire(1);
		emitter.fire(2);
		return calls;
	}),
	scenario('a fire from inside a listener of the same emitter', (make) => {
		const emitter = make<number>();
		const calls: string[] = [];
		emitter.event((n) => { calls.push(`a${n}`); if (n === 1) { emitter.fire(2); } });
		emitter.event((n) => calls.push(`b${n}`));
		emitter.event((n) => calls.push(`c${n}`));
		emitter.fire(1);
		return calls;
	}),
	scenario('the emitter disposed during a fire', (make) => {
		const emitter = make<number>();
		const calls: string[] = [];
		emitter.event((n) => { calls.push(`a${n}`); emitter.dispose(); });
		emitter.event((n) => calls.push(`b${n}`));
		emitter.fire(1);
		emitter.fire(2);
		return calls;
	}),
	scenario('after the emitter is disposed, fire does nothing and subscribing returns a disposable', (make) => {
		const emitter = make<number>();
		const calls: string[] = [];
		emitter.event(() => calls.push('before'));
		emitter.dispose();
		emitter.fire(1);
		const late = emitter.event(() => calls.push('after'));
		emitter.fire(2);
		let disposeThrew = false;
		try { late.dispose(); } catch { disposeThrew = true; }
		let fireThrew = false;
		try { emitter.fire(3); } catch { fireThrew = true; }
		return { calls, disposeThrew, fireThrew };
	}),
	scenario('the disposables collection receives the subscription', (make) => {
		const emitter = make<number>();
		const calls: string[] = [];
		const bag: { dispose(): unknown }[] = [];
		emitter.event(() => calls.push('a'), undefined, bag);
		emitter.fire(1);
		const collected = bag.length;
		for (const d of bag) { d.dispose(); }
		emitter.fire(2);
		return { calls, collected };
	}),
	scenario('this binds the listener', (make) => {
		const emitter = make<number>();
		const owner = { name: 'owner', seen: [] as string[] };
		emitter.event(function (this: typeof owner, n: number) { this.seen.push(`${this.name}${n}`); }, owner);
		emitter.fire(1);
		return owner.seen;
	}),
];

/** Runs every scenario against emitters from `make`. */
export function observeEmitter(make: EmitterFactory): Observation[] {
	return SCENARIOS.map((run) => run(make));
}
