export type OrderedWriter = {
  enqueue: (write: () => Promise<void>) => Promise<void>;
  close: () => void;
  drain: () => Promise<void>;
};

/**
 * Serialize asynchronous stream writes. A failed or closed connection must not
 * poison the chain, because later dashboard events can otherwise stop forever.
 */
export function createOrderedWriter(): OrderedWriter {
  let closed = false;
  let chain = Promise.resolve();

  return {
    enqueue(write) {
      chain = chain
        .then(async () => {
          if (!closed) await write();
        })
        .catch(() => {
          // Connection failures are expected during navigation and reconnects.
        });
      return chain;
    },
    close() {
      closed = true;
    },
    drain() {
      return chain;
    },
  };
}
