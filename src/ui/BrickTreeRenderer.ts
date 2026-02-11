import * as vscode from 'vscode';
import type { BrickSnapshot } from '../device/brickRegistry';
import { isRemoteExecutablePath } from '../fs/remoteExecutable';
import { createTransportThemeIcon } from './graphicsLibrary';
import type { BrickTreeNode, BrickRootNode } from './brickTreeProvider';

function buildEv3Uri(brickId: string, remotePath: string): vscode.Uri {
	return vscode.Uri.parse(`ev3://${brickId}${remotePath}`);
}

function buildRootNodeId(brickId: string): string {
	return `brick:${brickId}`;
}

function buildDirectoryNodeId(brickId: string, remotePath: string): string {
	return `dir:${brickId}:${remotePath}`;
}

function buildFileNodeId(brickId: string, remotePath: string): string {
	return `file:${brickId}:${remotePath}`;
}

function renderStatusBadge(status: BrickSnapshot['status'], isActive: boolean): string {
	if (status === 'READY' && isActive) {
		return 'ACTIVE';
	}
	if (status === 'UNAVAILABLE') {
		return 'OFFLINE';
	}
	return status;
}

function buildRootTooltip(node: BrickRootNode, description: string): string {
	const lines = [node.displayName];
	if (description.trim().length > 0) {
		lines.push(description);
	}
	if (node.lastError) {
		lines.push(`Error: ${node.lastError}`);
	}
	return lines.join('\n');
}

function getRootContextValue(node: BrickRootNode): string {
	if (node.status === 'READY') {
		return node.isActive ? 'ev3BrickRootReadyActive' : 'ev3BrickRootReady';
	}
	if (node.status === 'CONNECTING') {
		return 'ev3BrickRootConnecting';
	}
	if (node.status === 'ERROR') {
		return 'ev3BrickRootError';
	}
	return 'ev3BrickRootUnavailable';
}

function getRootIcon(node: BrickRootNode): vscode.ThemeIcon {
	if (node.status === 'READY') {
		if ((node.busyCommandCount ?? 0) > 0) {
			return new vscode.ThemeIcon('sync~spin');
		}
		return createTransportThemeIcon(node.transport);
	}
	if (node.status === 'CONNECTING') {
		return new vscode.ThemeIcon('sync~spin');
	}
	if (node.status === 'ERROR') {
		return new vscode.ThemeIcon('error');
	}
	return new vscode.ThemeIcon('debug-disconnect');
}

export interface RenderBrickTreeItemOptions {
	isFavoriteBrick?: (brickId: string) => boolean;
}

export function renderBrickTreeItem(node: BrickTreeNode, options?: RenderBrickTreeItemOptions): vscode.TreeItem {
	switch (node.kind) {
		case 'brick': {
			const item = new vscode.TreeItem(node.displayName, vscode.TreeItemCollapsibleState.Collapsed);
			item.id = buildRootNodeId(node.brickId);
			const statusBadge = renderStatusBadge(node.status, node.isActive);
			const descriptionParts = [statusBadge];
			if (options?.isFavoriteBrick?.(node.brickId)) {
				descriptionParts.push('PIN');
			}
			if ((node.busyCommandCount ?? 0) > 0) {
				descriptionParts.push(`busy:${node.busyCommandCount}`);
			}
			descriptionParts.push(node.transport, node.role);
			const description = descriptionParts.join(' | ');
			item.description = description;
			item.tooltip = buildRootTooltip(node, description);
			item.contextValue = getRootContextValue(node);
			item.iconPath = getRootIcon(node);
			item.resourceUri = buildEv3Uri(node.brickId, node.rootPath);
			return item;
		}
		case 'directory': {
			const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
			item.id = buildDirectoryNodeId(node.brickId, node.remotePath);
			item.contextValue = 'ev3RemoteDirectory';
			item.resourceUri = buildEv3Uri(node.brickId, node.remotePath);
			return item;
		}
		case 'file': {
			const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
			item.id = buildFileNodeId(node.brickId, node.remotePath);
			item.description = `${node.size} B`;
			const isExecutable = isRemoteExecutablePath(node.remotePath);
			item.contextValue = isExecutable ? 'ev3RemoteFileExecutable' : 'ev3RemoteFile';
			item.iconPath = new vscode.ThemeIcon(isExecutable ? 'play' : 'file');
			item.resourceUri = buildEv3Uri(node.brickId, node.remotePath);
			item.command = {
				command: 'vscode.open',
				title: 'Open Remote File',
				arguments: [item.resourceUri]
			};
			return item;
		}
		case 'message': {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.id = `message:${node.brickId}:${node.label}`;
			item.description = node.detail;
			item.contextValue = node.contextValue ?? 'ev3BrickMessage';
			item.iconPath = new vscode.ThemeIcon('info');
			item.command = node.command;
			return item;
		}
	}
}
