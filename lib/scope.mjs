// The folder and the keys a request works in. Every route of the review pane and the later features resolves its folder through
// scopeFor, and accepts an optional `thread` (in the body or the query). Until pro-01 adds threads with their own folders, every
// thread is the Main scope of its project: the project's own folder, and the project id as the key.
// store and threadId are not used yet; they are in the signature so the callers do not change when pro-01 lands.

export function scopeFor(store, project, threadId) {
  void store;
  void threadId;
  return {
    id: project.id,
    projectId: project.id,
    threadId: project.id,
    name: 'Main',
    root: project.path,
    worktree: null,
    chatMode: null,
    main: true,
    writer: true,
  };
}
