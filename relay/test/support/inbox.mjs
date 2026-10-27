// A queue of what a client received: messages in arrival order, then the close.
// Shared by the miniflare driver and the in-process fake runtime, so the
// scenarios read the same whichever runtime carries them.
export class Inbox {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.closeInfo = null;
    this.closeWaiters = [];
  }

  get isOpen() {
    return this.closeInfo === null;
  }

  push(message) {
    if (this.closeInfo) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.queue.push(message);
  }

  closeWith(info) {
    if (this.closeInfo) return;
    this.closeInfo = info;
    for (const done of this.closeWaiters.splice(0)) done(info);
  }

  // The next message: ArrayBuffer for binary, string for text.
  next(ms = 3000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const waiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('timed out waiting for a message'));
      }, ms);
      this.waiters.push(waiter);
    });
  }

  // Resolves true when nothing arrives within ms. A message that does arrive
  // stays queued for the next call to next().
  quiet(ms = 300) {
    if (this.queue.length > 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = (message) => {
        clearTimeout(timer);
        this.queue.unshift(message);
        resolve(false);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(true);
      }, ms);
      this.waiters.push(waiter);
    });
  }

  closed(ms = 3000) {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const done = (info) => {
        clearTimeout(timer);
        resolve(info);
      };
      const timer = setTimeout(() => {
        this.closeWaiters = this.closeWaiters.filter((w) => w !== done);
        reject(new Error('timed out waiting for the socket to close'));
      }, ms);
      this.closeWaiters.push(done);
    });
  }
}
