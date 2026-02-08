function escapeRegex(value: string): string {
	return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function normalizeGlobPattern(pattern: string): string {
	return pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function globToRegex(pattern: string): RegExp {
	const normalized = normalizeGlobPattern(pattern);
	let out = '^';

	for (let i = 0; i < normalized.length; i += 1) {
		const char = normalized[i];
		if (char === '*') {
			const next = normalized[i + 1];
			if (next === '*') {
				const after = normalized[i + 2];
				if (after === '/') {
					out += '(?:.*\\/)?';
					i += 2;
				} else {
					out += '.*';
					i += 1;
				}
			} else {
				out += '[^/]*';
			}
			continue;
		}

		if (char === '?') {
			out += '[^/]';
			continue;
		}

		out += escapeRegex(char);
	}

	out += '$';
	return new RegExp(out);
}

export function createGlobMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
	const normalized = patterns
		.map((entry) => normalizeGlobPattern(entry))
		.filter((entry) => entry.length > 0)
		.map((entry) => globToRegex(entry));

	return (relativePath: string): boolean => {
		const candidate = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
		return normalized.some((regex) => regex.test(candidate));
	};
}
