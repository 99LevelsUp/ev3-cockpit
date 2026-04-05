import { ValueDynamic } from './mockConfig';

/** Evaluate a dynamic value at a given timestamp. Returns undefined for `none` dynamics. */
export function evaluateDynamic(dynamic: ValueDynamic, now: number): number | string | undefined {
	switch (dynamic.kind) {
	case 'none':
		return undefined;

	case 'static':
		return dynamic.value;

	case 'sine': {
		const phase = ((now % dynamic.periodMs) / dynamic.periodMs) * 2 * Math.PI;
		const normalized = (Math.sin(phase) + 1) / 2; // 0..1
		return dynamic.min + normalized * (dynamic.max - dynamic.min);
	}

	case 'triangle': {
		const t = (now % dynamic.periodMs) / dynamic.periodMs;
		const normalized = t < 0.5 ? t * 2 : 2 - t * 2; // 0..1..0
		return dynamic.min + normalized * (dynamic.max - dynamic.min);
	}

	case 'square': {
		const t = (now % dynamic.periodMs) / dynamic.periodMs;
		return t < 0.5 ? dynamic.low : dynamic.high;
	}
	}
}
