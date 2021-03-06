/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import URI from 'vs/base/common/uri';
import objects = require('vs/base/common/objects');
import paths = require('vs/base/common/paths');
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import Event, { Emitter } from 'vs/base/common/event';
import { IConfigurationService, IConfigurationChangeEvent } from 'vs/platform/configuration/common/configuration';
import { ParsedExpression, IExpression, parse } from 'vs/base/common/glob';
import { basename } from 'vs/base/common/paths';
import { RawContextKey, IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IModeService } from 'vs/editor/common/services/modeService';

export class ResourceContextKey implements IContextKey<URI> {

	static Scheme = new RawContextKey<string>('resourceScheme', undefined);
	static Filename = new RawContextKey<string>('resourceFilename', undefined);
	static LangId = new RawContextKey<string>('resourceLangId', undefined);
	static Resource = new RawContextKey<URI>('resource', undefined);
	static Extension = new RawContextKey<string>('resourceExtname', undefined);

	private _resourceKey: IContextKey<URI>;
	private _schemeKey: IContextKey<string>;
	private _filenameKey: IContextKey<string>;
	private _langIdKey: IContextKey<string>;
	private _extensionKey: IContextKey<string>;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IModeService private _modeService: IModeService
	) {
		this._schemeKey = ResourceContextKey.Scheme.bindTo(contextKeyService);
		this._filenameKey = ResourceContextKey.Filename.bindTo(contextKeyService);
		this._langIdKey = ResourceContextKey.LangId.bindTo(contextKeyService);
		this._resourceKey = ResourceContextKey.Resource.bindTo(contextKeyService);
		this._extensionKey = ResourceContextKey.Extension.bindTo(contextKeyService);
	}

	set(value: URI) {
		this._resourceKey.set(value);
		this._schemeKey.set(value && value.scheme);
		this._filenameKey.set(value && basename(value.fsPath));
		this._langIdKey.set(value && this._modeService.getModeIdByFilenameOrFirstLine(value.fsPath));
		this._extensionKey.set(value && paths.extname(value.fsPath));
	}

	reset(): void {
		this._schemeKey.reset();
		this._langIdKey.reset();
		this._resourceKey.reset();
		this._langIdKey.reset();
		this._extensionKey.reset();
	}

	public get(): URI {
		return this._resourceKey.get();
	}
}

export class ResourceGlobMatcher {

	private static readonly NO_ROOT: string = null;

	private _onExpressionChange: Emitter<void>;
	private toUnbind: IDisposable[];
	private mapRootToParsedExpression: Map<string, ParsedExpression>;
	private mapRootToExpressionConfig: Map<string, IExpression>;

	constructor(
		private globFn: (root?: URI) => IExpression,
		private shouldUpdate: (event: IConfigurationChangeEvent) => boolean,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		this.toUnbind = [];

		this.mapRootToParsedExpression = new Map<string, ParsedExpression>();
		this.mapRootToExpressionConfig = new Map<string, IExpression>();

		this._onExpressionChange = new Emitter<void>();
		this.toUnbind.push(this._onExpressionChange);

		this.updateExcludes(false);

		this.registerListeners();
	}

	public get onExpressionChange(): Event<void> {
		return this._onExpressionChange.event;
	}

	private registerListeners(): void {
		this.toUnbind.push(this.configurationService.onDidChangeConfiguration(e => {
			if (this.shouldUpdate(e)) {
				this.updateExcludes(true);
			}
		}));
		this.toUnbind.push(this.contextService.onDidChangeWorkspaceFolders(() => this.updateExcludes(true)));
	}

	private updateExcludes(fromEvent: boolean): void {
		let changed = false;

		// Add excludes per workspaces that got added
		this.contextService.getWorkspace().folders.forEach(folder => {
			const rootExcludes = this.globFn(folder.uri);
			if (!this.mapRootToExpressionConfig.has(folder.uri.toString()) || !objects.equals(this.mapRootToExpressionConfig.get(folder.uri.toString()), rootExcludes)) {
				changed = true;

				this.mapRootToParsedExpression.set(folder.uri.toString(), parse(rootExcludes));
				this.mapRootToExpressionConfig.set(folder.uri.toString(), objects.clone(rootExcludes));
			}
		});

		// Remove excludes per workspace no longer present
		this.mapRootToExpressionConfig.forEach((value, root) => {
			if (root === ResourceGlobMatcher.NO_ROOT) {
				return; // always keep this one
			}

			if (!this.contextService.getWorkspaceFolder(URI.parse(root))) {
				this.mapRootToParsedExpression.delete(root);
				this.mapRootToExpressionConfig.delete(root);

				changed = true;
			}
		});

		// Always set for resources outside root as well
		const globalExcludes = this.globFn();
		if (!this.mapRootToExpressionConfig.has(ResourceGlobMatcher.NO_ROOT) || !objects.equals(this.mapRootToExpressionConfig.get(ResourceGlobMatcher.NO_ROOT), globalExcludes)) {
			changed = true;

			this.mapRootToParsedExpression.set(ResourceGlobMatcher.NO_ROOT, parse(globalExcludes));
			this.mapRootToExpressionConfig.set(ResourceGlobMatcher.NO_ROOT, objects.clone(globalExcludes));
		}

		if (fromEvent && changed) {
			this._onExpressionChange.fire();
		}
	}

	public matches(resource: URI): boolean {
		const folder = this.contextService.getWorkspaceFolder(resource);

		let expressionForRoot: ParsedExpression;
		if (folder && this.mapRootToParsedExpression.has(folder.uri.toString())) {
			expressionForRoot = this.mapRootToParsedExpression.get(folder.uri.toString());
		} else {
			expressionForRoot = this.mapRootToParsedExpression.get(ResourceGlobMatcher.NO_ROOT);
		}

		// If the resource if from a workspace, convert its absolute path to a relative
		// path so that glob patterns have a higher probability to match. For example
		// a glob pattern of "src/**" will not match on an absolute path "/folder/src/file.txt"
		// but can match on "src/file.txt"
		let resourcePathToMatch: string;
		if (folder) {
			resourcePathToMatch = paths.normalize(paths.relative(folder.uri.fsPath, resource.fsPath));
		} else {
			resourcePathToMatch = resource.fsPath;
		}

		return !!expressionForRoot(resourcePathToMatch);
	}

	public dispose(): void {
		this.toUnbind = dispose(this.toUnbind);
	}
}
