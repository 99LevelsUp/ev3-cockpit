/**
 * The contract between the cockpit daemon and its clients: the VS Code extension, the `ev3`
 * command, MCP servers and add-ons. Plain types and a few constants; nothing here touches a brick,
 * the file system or a native module, so an add-on can depend on it alone.
 */

export * from './version';
export * from './errors';
export * from './models';
export * from './methods';
export * from './events';
