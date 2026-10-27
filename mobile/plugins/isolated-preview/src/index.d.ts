// Types for the isolated-preview plugin (mob-13). Runtime code is in index.js and core.js.
export interface IsolatedPreviewPlugin {
  show(options: { html: string; title?: string }): Promise<void>;
}

export declare const IsolatedPreview: IsolatedPreviewPlugin;
export default IsolatedPreview;
export * from './core';
