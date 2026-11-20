// The repository resolves modules the classic Node way, which does not read a package's
// `exports` map. vscode-jsonrpc publishes its Node entry point only there, so its types are
// pointed at here; at run time Node and esbuild read the map themselves.
declare module 'vscode-jsonrpc/node' {
	export * from 'vscode-jsonrpc/lib/node/main';
}
