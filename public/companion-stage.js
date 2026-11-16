// Own only player lifetimes. Fetching, drawing and CSS transitions stay with
// the caller so this coordinator can be checked without a browser or WebGL.
export function createCompanionStage({ dispose, transition }) {
  let active;
  let pending;
  let outgoing;
  let cancelTransition;
  let transitionId = 0;
  const released = new WeakSet();

  function release(record) {
    if (!record || released.has(record)) return;
    released.add(record);
    // Abort handlers may call fail() synchronously. State is detached before
    // release(), and the WeakSet also makes cleanup safe to repeat.
    record.controller?.abort();
    dispose(record);
  }

  function cancelFade() {
    transitionId += 1;
    const cancel = cancelTransition;
    cancelTransition = undefined;
    cancel?.();
  }

  return {
    get active() { return active; },
    get pending() { return pending; },
    get outgoing() { return outgoing; },

    begin(record) {
      if (!record || typeof record !== 'object') throw new TypeError('A stage record is required');
      if (record === pending) return true;
      if (record === active || record === outgoing || released.has(record)) return false;
      cancelFade();
      const oldPending = pending;
      const oldOutgoing = outgoing;
      pending = undefined;
      outgoing = undefined;
      release(oldPending);
      release(oldOutgoing);
      pending = record;
      return true;
    },

    // Call only after the candidate has drawn its first complete frame.
    present(record) {
      if (record !== pending || released.has(record)) return false;
      const previous = active;
      pending = undefined;
      active = record;
      if (!previous) return true;

      outgoing = previous;
      const id = ++transitionId;
      const done = () => {
        if (id !== transitionId || outgoing !== previous) return;
        outgoing = undefined;
        cancelTransition = undefined;
        release(previous);
      };
      try {
        const cancel = transition(previous, record, done);
        if (id === transitionId && outgoing === previous) cancelTransition = cancel;
        else cancel?.(); // Includes synchronous, reduced-motion completion.
      } catch (error) {
        done();
        throw error;
      }
      return true;
    },

    fail(record) {
      if (record !== pending) return false;
      pending = undefined;
      release(record);
      return true;
    },

    clear() {
      cancelFade();
      const records = [pending, outgoing, active];
      pending = undefined;
      outgoing = undefined;
      active = undefined;
      records.forEach(release);
    },
  };
}
